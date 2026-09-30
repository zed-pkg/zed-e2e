#!/usr/bin/env python3
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = "e2e-token"
SERVICE_TOKEN = "0123456789abcdef0123456789abcdef"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("auth_stub:", fmt % args, flush=True)

    def _json(self, status, body):
        payload = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/healthz":
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "not_found"})

    def do_POST(self):
        if self.path == "/introspect":
            if self.headers.get("authorization") != f"Bearer {TOKEN}":
                self._json(401, {"active": False, "user_id": "", "tenant_ids": []})
                return
            self._json(200, {
                "active": True,
                "user_id": "e2e-user",
                "tenant_ids": ["acme"],
            })
            return

        if self.path == "/security-state":
            if self.headers.get("authorization") != f"Bearer {SERVICE_TOKEN}":
                self._json(401, {"error": "unauthorized"})
                return
            self._json(200, {"blocked": False})
            return

        self._json(404, {"error": "not_found"})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 9191), Handler).serve_forever()
