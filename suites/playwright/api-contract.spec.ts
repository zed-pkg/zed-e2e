import { test, expect } from "@playwright/test";
import { API_URL } from "../../harness/stack.js";
import { ensureSeeded, SEED } from "../../harness/fixtures.js";

// Exercises the Rust API server's REST contract directly (no browser).
test.describe("zed-api-server REST contract", () => {
  test.beforeAll(async () => {
    await ensureSeeded();
  });

  test("healthz reports the service is up", async ({ request }) => {
    const res = await request.get(`${API_URL}/healthz`);
    expect(res.ok()).toBeTruthy();
  });

  test("GET package returns metadata with versions", async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/packages/acme/http-kit`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.org).toBe("acme");
    expect(body.name).toBe("http-kit");
    expect(body.versions).toContain("1.2.0");
    expect(body.latest).toBe("1.2.0");
  });

  test("GET version returns a pinnable artifact record", async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/packages/acme/http-kit/versions/1.2.0`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.size).toBeGreaterThan(0);
    expect(["tar.gz", "zip"]).toContain(body.format);
  });

  test("unknown package is a clean 404 with an error code", async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/packages/acme/does-not-exist`);
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBeTruthy();
  });

  test("search matches by name and description", async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/search`, { params: { q: "http" } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const names = body.items.map((i: { name: string }) => i.name);
    expect(names).toContain("http-kit");
  });

  test("LIKE wildcards in search are treated literally", async ({ request }) => {
    // A bare "%" must not act as a wildcard matching everything.
    const res = await request.get(`${API_URL}/v1/search`, { params: { q: "%" } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(0);
  });

  test("publish without a token is rejected", async ({ request }) => {
    const res = await request.put(
      `${API_URL}/v1/packages/acme/http-kit/versions/9.9.9`,
      { multipart: { meta: "{}", artifact: { name: "a.tar.gz", mimeType: "application/gzip", buffer: Buffer.from("x") } } },
    );
    expect([401, 403]).toContain(res.status());
  });

  test("unpkg-style file route serves a file from inside the artifact", async ({ request }) => {
    await ensureSeeded();
    const res = await request.get(`${API_URL}/v1/files/acme/http-kit/1.2.0/src/index.js`);
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain("http-kit");
  });

  test("nosniff header is present on responses", async ({ request }) => {
    const res = await request.get(`${API_URL}/healthz`);
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("seed dataset is fully queryable", async ({ request }) => {
    for (const pkg of SEED.packages) {
      const res = await request.get(`${API_URL}/v1/packages/${pkg.org}/${pkg.name}`);
      expect(res.status(), `${pkg.name} should exist`).toBe(200);
    }
  });
});
