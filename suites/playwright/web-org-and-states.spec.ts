import { test, expect } from "@playwright/test";
import { WEB_URL, createToken } from "../../harness/stack.js";
import { ensureSeeded, publishFixture } from "../../harness/fixtures.js";

// Web routes/states the other UI suites don't touch: the org page, the search
// empty/no-match states, the HSTS header, and static-asset serving (a broken
// htmx.min.js silently flakes every search test).
test.describe("zed-web-server routes and empty states", () => {
  const org = `orgpage-${Date.now().toString(36)}`;

  test.beforeAll(async () => {
    await ensureSeeded();
    const token = await createToken(`${org}-owner`, org);
    await publishFixture({ org, name: "alpha", version: "1.0.0", description: "org page fixture" }, { token, allowExisting: true });
  });

  test("org page lists the org's packages", async ({ page }) => {
    await page.goto(`${WEB_URL}/orgs/${org}`);
    await expect(page.locator("body")).toContainText("alpha");
  });

  test("unknown org page returns 404", async ({ page }) => {
    const res = await page.goto(`${WEB_URL}/orgs/does-not-exist-${Date.now().toString(36)}`);
    expect(res!.status()).toBe(404);
  });

  test("search page renders the search box", async ({ page }) => {
    await page.goto(`${WEB_URL}/search`);
    await expect(page.locator("h1")).toContainText("Search");
    await expect(page.locator("#q")).toBeVisible();
  });

  test("a no-match search shows the empty state", async ({ page }) => {
    await page.goto(`${WEB_URL}/search`);
    await page.fill("#q", "zzz-nothing-matches-this-zzz");
    await expect(page.locator("#results")).toContainText("no matches", { timeout: 10_000 });
  });

  test("responses carry HSTS and a hardened CSP", async ({ page }) => {
    const res = await page.goto(`${WEB_URL}/`);
    const headers = res!.headers();
    expect(headers["strict-transport-security"]).toContain("max-age=");
    const csp = headers["content-security-policy"];
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  test("static assets are served", async ({ request }) => {
    for (const asset of ["/static/htmx.min.js", "/static/styles.css", "/static/favicon.svg"]) {
      const res = await request.get(`${WEB_URL}${asset}`);
      expect(res.status(), `${asset} should be 200`).toBe(200);
    }
  });
});
