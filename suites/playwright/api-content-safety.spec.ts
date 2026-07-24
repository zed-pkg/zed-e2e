import { test, expect } from "@playwright/test";
import { API_URL, createToken } from "../../harness/stack.js";
import { publishFixture } from "../../harness/fixtures.js";

// Published package files must never be served as ACTIVE content from the
// registry origin (stored-XSS / phishing host). The server serves html/svg/js
// entries as text/plain and sandboxes every /v1/files response. This is the
// browser-relevant half of the H2 hardening.
test.describe("zed-api-server serves package content inertly", () => {
  const org = `content-${Date.now().toString(36)}`;
  const version = "1.0.0";
  const base = `${API_URL}/v1/files/${org}/danger/${version}`;

  test.beforeAll(async () => {
    const token = await createToken(`${org}-owner`, org);
    await publishFixture(
      { org, name: "danger", version, description: "content-safety fixture" },
      {
        token,
        allowExisting: true,
        files: {
          "www/evil.html": "<script>window.__pwned = 1</script><h1>hi</h1>",
          "img/evil.svg": '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__pwned=1</script></svg>',
          "src/app.js": "export const x = 1;",
        },
      },
    );
  });

  test("an HTML entry is served as text/plain, not text/html", async ({ request }) => {
    const res = await request.get(`${base}/www/evil.html`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/plain");
  });

  test("an SVG entry is served as text/plain, not image/svg+xml", async ({ request }) => {
    const res = await request.get(`${base}/img/evil.svg`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/plain");
    expect(res.headers()["content-type"]).not.toContain("svg");
  });

  test("a JS entry is not served as executable javascript", async ({ request }) => {
    const res = await request.get(`${base}/src/app.js`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).not.toContain("javascript");
  });

  test("every file response is sandboxed and non-sniffable", async ({ request }) => {
    const res = await request.get(`${base}/www/evil.html`);
    expect(res.headers()["content-security-policy"]).toContain("sandbox");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["content-disposition"]).toContain("inline");
  });

  test("a real browser does not execute a served HTML entry", async ({ page }) => {
    await page.goto(`${base}/www/evil.html`);
    // Served as text/plain, so the <script> is inert text, never run.
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeFalsy();
  });
});
