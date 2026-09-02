#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument sequence near ${key ?? "<end>"}`);
    }
    values.set(key.slice(2), value);
  }
  for (const required of ["config", "infra-root", "evidence"]) {
    if (!values.has(required)) throw new Error(`--${required} is required`);
  }
  return Object.fromEntries(values);
}

const args = parseArgs(process.argv);
const config = JSON.parse(await readFile(args.config, "utf8"));
if (config.schema !== "zed-pkg-test.public-edge-fallback-canaries/v1") {
  throw new Error(`unexpected fixture schema: ${config.schema}`);
}
const repository = config.repository;
const canaries = config.canaries;
if (!repository || !Array.isArray(canaries) || canaries.length < 2) {
  throw new Error("fixture ledger requires repository metadata and multiple canaries");
}

const workerUrl = pathToFileURL(
  path.resolve(args["infra-root"], "workers/registry-proxy/src/entry.js"),
).href;
const { default: registryWorker } = await import(workerUrl);

const evidence = {
  schema: "zed-e2e.test-org-github-fallback-attestation/v1",
  generated_at: new Date().toISOString(),
  git_sha: process.env.GITHUB_SHA || null,
  github_run_id: process.env.GITHUB_RUN_ID || null,
  fixture_ref: process.env.TEST_HARNESS_REF || null,
  infra_ref: process.env.INFRA_REF || null,
  canary_versions: canaries.map((item) => item.version),
  checks: {},
};
const failures = [];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function proofHeaders(response) {
  const names = [
    "cache-control",
    "content-length",
    "content-type",
    "retry-after",
    "x-zed-edge",
    "x-zed-source",
  ];
  return Object.fromEntries(
    names
      .map((name) => [name, response.headers.get(name)])
      .filter(([, value]) => value !== null),
  );
}

async function fetchWithRetries(url, init = {}, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status < 500 || attempt === attempts) return response;
      await response.body?.cancel();
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  throw lastError || new Error(`unable to fetch ${url}`);
}

async function record(name, operation) {
  try {
    const result = await operation();
    const ok = result?.ok !== false;
    evidence.checks[name] = { ok, required: true, ...result };
    if (!ok) failures.push(name);
  } catch (error) {
    evidence.checks[name] = {
      ok: false,
      required: true,
      error: error instanceof Error ? error.message : String(error),
    };
    failures.push(name);
  }
}

function originDownEnv() {
  return {
    ORIGIN_URL: "http://127.0.0.1:9",
    ORIGIN_TIMEOUT_MS: "100",
    FALLBACK_TIMEOUT_MS: "15000",
  };
}

const direct = new Map();
for (const canary of canaries) {
  const releaseBase =
    `https://github.com/${repository.org}/${repository.repo}/releases/download/${canary.tag}`;
  const assetUrl = `${releaseBase}/${canary.asset}`;
  const sidecarUrl = `${releaseBase}/${canary.sidecar}`;

  await record(`direct_fixture_${canary.version}`, async () => {
    const sidecarResponse = await fetchWithRetries(sidecarUrl, {
      headers: { Accept: "application/json" },
      redirect: "follow",
    });
    const assetResponse = await fetchWithRetries(assetUrl, {
      headers: { Accept: "application/octet-stream" },
      redirect: "follow",
    });
    if (!sidecarResponse.ok || !assetResponse.ok) {
      throw new Error(
        `fixture ${canary.version} returned sidecar=${sidecarResponse.status} asset=${assetResponse.status}`,
      );
    }
    const metadata = await sidecarResponse.json();
    const bytes = Buffer.from(await assetResponse.arrayBuffer());
    const digest = sha256(bytes);
    const ok =
      metadata.org === repository.org &&
      metadata.name === repository.package &&
      metadata.version === canary.version &&
      metadata.sha256 === canary.sha256 &&
      metadata.size === canary.bytes &&
      metadata.download_url === assetUrl &&
      digest === canary.sha256 &&
      bytes.byteLength === canary.bytes;
    if (ok) direct.set(canary.version, { metadata, bytes, assetUrl });
    return {
      ok,
      sidecar_status: sidecarResponse.status,
      archive_status: assetResponse.status,
      sha256: digest,
      bytes: bytes.byteLength,
    };
  });

  await record(`origin_down_version_${canary.version}`, async () => {
    const expected = direct.get(canary.version);
    if (!expected) throw new Error("direct fixture proof did not pass");
    const route =
      `/v1/packages/${repository.org}/${repository.package}/versions/${canary.version}`;
    const response = await registryWorker.fetch(
      new Request(`https://registry.zpkg.net${route}`, {
        headers: { Accept: "application/json" },
      }),
      originDownEnv(),
    );
    const metadata = await response.json();
    const matching = ["org", "name", "version", "sha256", "size", "download_url"].every(
      (key) => metadata[key] === expected.metadata[key],
    );
    return {
      ok:
        response.status === 200 &&
        response.headers.get("x-zed-edge") === "registry" &&
        response.headers.get("x-zed-source") === "github-public" &&
        matching,
      status: response.status,
      headers: proofHeaders(response),
      metadata,
    };
  });

  await record(`origin_down_head_${canary.version}`, async () => {
    const route =
      `/v1/packages/${repository.org}/${repository.package}/versions/${canary.version}`;
    const response = await registryWorker.fetch(
      new Request(`https://registry.zpkg.net${route}`, {
        method: "HEAD",
        headers: { Accept: "application/json" },
      }),
      originDownEnv(),
    );
    const body = Buffer.from(await response.arrayBuffer());
    return {
      ok:
        response.status === 200 &&
        body.byteLength === 0 &&
        response.headers.get("x-zed-edge") === "registry" &&
        response.headers.get("x-zed-source") === "github-public",
      status: response.status,
      headers: proofHeaders(response),
      body_bytes: body.byteLength,
    };
  });
}

await record("origin_down_package_metadata", async () => {
  const route = `/v1/packages/${repository.org}/${repository.package}`;
  const response = await registryWorker.fetch(
    new Request(`https://registry.zpkg.net${route}`, {
      headers: { Accept: "application/json" },
    }),
    originDownEnv(),
  );
  const metadata = await response.json();
  const expectedVersions = canaries.map((item) => item.version);
  const versions = Array.isArray(metadata.versions) ? metadata.versions : [];
  const sortedVersions = [...versions].sort((left, right) =>
    left < right ? 1 : left > right ? -1 : 0,
  );
  const extraVersions = versions.filter(
    (version) => !expectedVersions.includes(version),
  );
  return {
    ok:
      response.status === 200 &&
      response.headers.get("x-zed-edge") === "registry" &&
      response.headers.get("x-zed-source") === "github-public" &&
      metadata.org === repository.org &&
      metadata.name === repository.repo &&
      metadata.repo_url === `https://github.com/${repository.org}/${repository.repo}` &&
      expectedVersions.every((version) => versions.includes(version)) &&
      metadata.latest === versions[0] &&
      JSON.stringify(versions) === JSON.stringify(sortedVersions),
    status: response.status,
    headers: proofHeaders(response),
    metadata,
    expected_versions: expectedVersions,
    extra_versions: extraVersions,
  };
});

await record("origin_down_health_is_explicitly_degraded", async () => {
  const response = await registryWorker.fetch(
    new Request("https://registry.zpkg.net/healthz", {
      headers: { Accept: "application/json" },
    }),
    originDownEnv(),
  );
  const health = await response.json();
  return {
    ok:
      response.status === 200 &&
      response.headers.get("x-zed-edge") === "registry" &&
      response.headers.get("x-zed-source") === "edge-fallback" &&
      health.ok === true &&
      health.degraded === true &&
      health.db === false &&
      Array.isArray(health.fallbacks) &&
      health.fallbacks.includes("github-public"),
    status: response.status,
    headers: proofHeaders(response),
    health,
  };
});

await record("origin_down_write_fails_closed", async () => {
  const canary = canaries.at(-1);
  const route =
    `/v1/packages/${repository.org}/${repository.package}/versions/${canary.version}`;
  const response = await registryWorker.fetch(
    new Request(`https://registry.zpkg.net${route}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: "must-not-publish-through-github",
    }),
    originDownEnv(),
  );
  const problem = await response.json();
  return {
    ok:
      response.status === 503 &&
      response.headers.get("x-zed-edge") === "registry" &&
      response.headers.get("x-zed-source") === "edge" &&
      response.headers.get("retry-after") === "30" &&
      problem.error === "registry_origin_unavailable",
    status: response.status,
    headers: proofHeaders(response),
    problem,
  };
});

await record("missing_release_fails_closed", async () => {
  const version = "99.99.99-missing";
  const route =
    `/v1/packages/${repository.org}/${repository.package}/versions/${version}`;
  const response = await registryWorker.fetch(
    new Request(`https://registry.zpkg.net${route}`, {
      headers: { Accept: "application/json" },
    }),
    originDownEnv(),
  );
  const problem = await response.json();
  return {
    ok:
      response.status === 503 &&
      response.headers.get("x-zed-edge") === "registry" &&
      problem.error === "registry_origin_unavailable" &&
      !("download_url" in problem),
    status: response.status,
    headers: proofHeaders(response),
    problem,
  };
});

await record("denied_routes_are_io_free", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("denied route must not perform network I/O");
  };
  try {
    const denied = await registryWorker.fetch(
      new Request("https://registry.zpkg.net/v1/account/me"),
      originDownEnv(),
    );
    const invalidMethod = await registryWorker.fetch(
      new Request(
        `https://registry.zpkg.net/v1/packages/${repository.org}/${repository.package}`,
        { method: "DELETE" },
      ),
      originDownEnv(),
    );
    return {
      ok:
        denied.status === 404 &&
        invalidMethod.status === 405 &&
        denied.headers.get("x-zed-edge") === "registry" &&
        invalidMethod.headers.get("x-zed-edge") === "registry" &&
        calls === 0,
      denied_status: denied.status,
      invalid_method_status: invalidMethod.status,
      network_calls: calls,
    };
  } finally {
    globalThis.fetch = realFetch;
  }
});

evidence.summary = {
  required_failures: failures,
  all_required_checks_passed: failures.length === 0,
  canary_versions: canaries.map((item) => item.version),
  rust_origin: "intentionally-unreachable-loopback",
};

await mkdir(path.dirname(args.evidence), { recursive: true });
await writeFile(args.evidence, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify(evidence, null, 2));

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = [
    "# zed-pkg-test GitHub fallback contract",
    "",
    "| Check | Result |",
    "|---|---:|",
    ...Object.entries(evidence.checks).map(
      ([name, result]) => `| \`${name}\` | ${result.ok ? "PASS" : "FAIL"} |`,
    ),
    "",
    `Required failures: **${failures.length}**`,
    "",
  ];
  await appendFile(process.env.GITHUB_STEP_SUMMARY, rows.join("\n"), "utf8");
}

if (failures.length > 0) process.exitCode = 1;
