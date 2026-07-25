import { test, expect } from "@playwright/test";
import { API_URL } from "../../harness/stack.js";
import { ensureSeeded } from "../../harness/fixtures.js";

// Negative + security-focused contract checks: malformed inputs and hostile
// paths must produce clean 4xx responses, never a 500 or a traversal leak.
test.describe("zed-api-server validation + security", () => {
  test.beforeAll(async () => {
    await ensureSeeded();
  });

  test("path traversal on the unpkg file route does not escape the artifact", async ({ request }) => {
    for (const evil of [
      "/v1/files/acme/http-kit/1.2.0/../../../../etc/passwd",
      "/v1/files/acme/http-kit/1.2.0/..%2f..%2f..%2fetc%2fpasswd",
      "/v1/files/acme/http-kit/1.2.0/%2e%2e/%2e%2e/etc/passwd",
    ]) {
      const res = await request.get(`${API_URL}${evil}`);
      expect([400, 404], `${evil} -> ${res.status()}`).toContain(res.status());
      const body = await res.text();
      expect(body).not.toContain("root:"); // no /etc/passwd content leaked
    }
  });

  test("a file that isn't in the artifact is a clean 404", async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/files/acme/http-kit/1.2.0/does/not/exist.js`);
    expect(res.status()).toBe(404);
  });

  test("unknown version is a 404 with an error code, not a 500", async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/packages/acme/http-kit/versions/9.9.9`);
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBeTruthy();
  });

  test("a malformed artifact digest is rejected cleanly (no 500)", async ({ request }) => {
    for (const bad of ["not-a-sha", "deadbeef", "%2e%2e", "g".repeat(64)]) {
      const res = await request.get(`${API_URL}/v1/artifacts/${bad}`);
      expect([400, 404], `${bad} -> ${res.status()}`).toContain(res.status());
    }
  });

  test("search tolerates empty, whitespace, and oversized queries without 500", async ({ request }) => {
    for (const q of ["", "   ", "a".repeat(5000), "'; DROP TABLE packages;--", "%_%"]) {
      const res = await request.get(`${API_URL}/v1/search`, { params: { q } });
      expect(res.status(), `q=${JSON.stringify(q.slice(0, 20))} -> ${res.status()}`).toBeLessThan(500);
      const body = await res.json();
      expect(Array.isArray(body.items)).toBeTruthy();
    }
  });

  test("SQL-injection-shaped search is treated as a literal (tables still intact)", async ({ request }) => {
    await request.get(`${API_URL}/v1/search`, { params: { q: "'); DROP TABLE version;--" } });
    // If the injection had executed, the seed would be gone. It must survive.
    const res = await request.get(`${API_URL}/v1/packages/acme/http-kit`);
    expect(res.status()).toBe(200);
    expect((await res.json()).versions).toContain("1.2.0");
  });

  test("publish with no token is refused before any storage write", async ({ request }) => {
    const res = await request.put(
      `${API_URL}/v1/packages/acme/http-kit/versions/9.9.9`,
      { multipart: { meta: "{}", artifact: { name: "a.tar.gz", mimeType: "application/gzip", buffer: Buffer.from("x") } } },
    );
    expect([401, 403]).toContain(res.status());
    // And the rejected version must not have been recorded.
    const check = await request.get(`${API_URL}/v1/packages/acme/http-kit/versions/9.9.9`);
    expect(check.status()).toBe(404);
  });

  test("unknown routes 404 cleanly", async ({ request }) => {
    for (const path of ["/v1/nope", "/v1/packages", "/v1/packages/acme", "/../../etc/passwd"]) {
      const res = await request.get(`${API_URL}${path}`);
      expect(res.status(), `${path} -> ${res.status()}`).toBeLessThan(500);
    }
  });
});
