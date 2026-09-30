#!/usr/bin/env python3
import json
import socket
import struct
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8081"
AUTH = {"Authorization": "Bearer e2e-token", "Content-Type": "application/json"}
DIGEST = "a" * 64
DEPLOYMENT = "critical-orders"


def request(method, path, body=None, expected=(200,)):
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=AUTH)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            status = resp.status
            payload = json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as err:
        status = err.code
        payload = json.loads(err.read() or b"{}")
    if status not in expected:
        raise AssertionError(f"{method} {path}: expected {expected}, got {status}: {payload}")
    return status, payload


def guest_control(payload):
    raw = json.dumps(payload, separators=(",", ":")).encode()
    with socket.create_connection(("127.0.0.1", 9101), timeout=5) as sock:
        sock.sendall(struct.pack(">I", len(raw)) + raw)
        header = recv_exact(sock, 4)
        size = struct.unpack(">I", header)[0]
        return json.loads(recv_exact(sock, size))


def recv_exact(sock, size):
    chunks = []
    remaining = size
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk:
            raise RuntimeError("guest-control socket closed early")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


proof = {"checks": []}

status, deployment = request("POST", "/v1/critical-sections/deployments", {
    "deployment_id": DEPLOYMENT,
    "tenant_id": "acme",
    "namespace": "orders",
    "language": "gleam",
    "build_sha256": DIGEST,
    "tenancy_class": "tenant_dedicated",
}, expected=(201,))
assert deployment["tenant_id"] == "acme"
assert deployment["execution_class"] == "durable_actor"
assert deployment["isolation_class"] == "firecracker"
assert deployment["runtime_epoch"] >= 1
proof["checks"].append({"name": "deployment", "status": status, "runtime_epoch": deployment["runtime_epoch"]})

_, first = request("POST", f"/v1/critical-sections/{DEPLOYMENT}/acquire", {
    "key": "cart-42", "holder": "worker-a", "lease_ms": 10000,
})
assert first["ok"] is True
first_token = first["token"]
assert first_token["runtime_epoch"] == deployment["runtime_epoch"]
assert first_token["owner_epoch"] >= 1
assert first_token["sequence"] == 1
proof["checks"].append({"name": "first_acquire", "token": first_token})

status, busy = request("POST", f"/v1/critical-sections/{DEPLOYMENT}/acquire", {
    "key": "cart-42", "holder": "worker-b", "lease_ms": 10000,
}, expected=(409,))
assert busy["ok"] is False and busy["error_code"] == "busy"
proof["checks"].append({"name": "mutual_exclusion", "status": status, "error_code": busy["error_code"]})

_, renewed = request("POST", f"/v1/critical-sections/{DEPLOYMENT}/renew", {
    "key": "cart-42", "holder": "worker-a", "lease_ms": 10000, "token": first_token,
})
assert renewed["ok"] is True and renewed["token"] == first_token
proof["checks"].append({"name": "holder_renew", "token": renewed["token"]})

status, stale = request("POST", f"/v1/critical-sections/{DEPLOYMENT}/release", {
    "key": "cart-42", "holder": "worker-b", "token": first_token,
}, expected=(409,))
assert stale["ok"] is False and stale["error_code"] == "stale_or_not_owner"
proof["checks"].append({"name": "stale_release_rejected", "status": status})

_, released = request("POST", f"/v1/critical-sections/{DEPLOYMENT}/release", {
    "key": "cart-42", "holder": "worker-a", "token": first_token,
})
assert released["ok"] is True

_, second = request("POST", f"/v1/critical-sections/{DEPLOYMENT}/acquire", {
    "key": "cart-42", "holder": "worker-b", "lease_ms": 10000,
})
second_token = second["token"]
assert second_token["runtime_epoch"] == first_token["runtime_epoch"]
assert second_token["owner_epoch"] == first_token["owner_epoch"]
assert second_token["sequence"] > first_token["sequence"]
proof["checks"].append({"name": "fence_monotonic_after_release", "token": second_token})

_, short = request("POST", f"/v1/critical-sections/{DEPLOYMENT}/acquire", {
    "key": "expiring-key", "holder": "worker-a", "lease_ms": 100,
})
time.sleep(0.25)
_, after_expiry = request("POST", f"/v1/critical-sections/{DEPLOYMENT}/acquire", {
    "key": "expiring-key", "holder": "worker-b", "lease_ms": 1000,
})
assert after_expiry["token"]["sequence"] > short["token"]["sequence"]
proof["checks"].append({"name": "expiry_reacquire", "before": short["token"], "after": after_expiry["token"]})

cross_tenant = guest_control({
    "op": "critical_section",
    "operation": "acquire",
    "tenant_id": "other-tenant",
    "namespace": "orders",
    "object_key": "cross-tenant-key",
    "runtime_epoch": deployment["runtime_epoch"],
    "holder": "intruder",
    "lease_ms": 1000,
})
assert cross_tenant["ok"] is False
assert cross_tenant["error_code"] == "runtime_error"
assert "error_etf_base64" in cross_tenant
proof["checks"].append({"name": "tenant_vm_binding", "error_code": cross_tenant["error_code"]})

status, forbidden = request("POST", "/v1/critical-sections/deployments", {
    "deployment_id": "other-tenant-deployment",
    "tenant_id": "other-tenant",
    "namespace": "orders",
    "language": "erlang",
    "build_sha256": "b" * 64,
    "tenancy_class": "tenant_dedicated",
}, expected=(403,))
proof["checks"].append({"name": "api_tenant_authorization", "status": status, "error": forbidden.get("error")})

proof["result"] = "PASS"
proof["scope"] = {
    "real": [
        "bmscl-api-server critical-section routes",
        "runtime-control HMAC request signing and verification",
        "bmscl-runtime-host HTTP critical-section admission",
        "packet-4 guest-control transport",
        "bmscl_guest_control",
        "bmscl_critical_section_registry",
        "bmscl_critical_section_actor",
        "ores-compose orchestration",
    ],
    "mocked": ["Firecracker/KVM lifecycle only"],
}
Path(__file__).with_name("proof.json").write_text(json.dumps(proof, indent=2, sort_keys=True) + "\n")
print(json.dumps(proof, indent=2, sort_keys=True))
