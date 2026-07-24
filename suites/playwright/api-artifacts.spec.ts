import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { API_URL } from "../../harness/stack.js";
import { ensureSeeded } from "../../harness/fixtures.js";

// Closes the publish -> download loop at the raw-artifact layer (the CLI covers
// install; this covers GET /v1/artifacts/{sha256} directly) and the
// unpkg-style /v1/files failure paths.
test.describe("zed-api-server artifact download", () => {
  test.beforeAll(async () => {
    await ensureSeeded();
  });

  test("download by sha256 returns the exact bytes the metadata pins", async ({ request }) => {
    const meta = await (await request.get(`${API_URL}/v1/packages/acme/http-kit/versions/1.2.0`)).json();
    const sha: string = meta.sha256;

    const res = await request.get(`${API_URL}/v1/artifacts/${sha}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toContain("immutable");

    const body = await res.body();
    expect(body.length).toBe(meta.size);
    expect(createHash("sha256").update(body).digest("hex")).toBe(sha);
  });

  test("download of an unknown sha256 is a 404", async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/artifacts/${"0".repeat(64)}`);
    expect(res.status()).toBe(404);
  });

  test("a file that is not in the archive is a 404", async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/files/acme/http-kit/1.2.0/does/not/exist.js`);
    expect(res.status()).toBe(404);
  });

  test("path traversal in the file route cannot escape the archive", async ({ request }) => {
    // The handler does an exact-string match against archive entry names, so
    // ".." is inert — it simply matches no entry.
    const res = await request.get(`${API_URL}/v1/files/acme/http-kit/1.2.0/../../../../etc/passwd`);
    expect(res.status()).toBe(404);
  });
});
