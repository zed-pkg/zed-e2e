import { test, expect } from "@playwright/test";
import { WEB_URL } from "../../harness/stack.js";
import { ensureSeeded } from "../../harness/fixtures.js";

// Drives the Rust web server (MASH: Maud + Axum + SeaORM + HTMX) in a real
// browser via Playwright.
test.describe("zed-web-server UI", () => {
  test.beforeAll(async () => {
    await ensureSeeded();
  });

  test("home page lists recently published packages", async ({ page }) => {
    await page.goto(`${WEB_URL}/`);
    await expect(page.locator(".brand")).toContainText("zed");
    const list = page.locator(".pkg-list");
    await expect(list).toBeVisible();
    await expect(list).toContainText("http-kit");
  });

  test("HTMX live search returns matching results into #results", async ({ page }) => {
    await page.goto(`${WEB_URL}/search`);
    await page.fill("#q", "logkit");
    // htmx swaps the fragment into #results on keyup (debounced).
    await expect(page.locator("#results")).toContainText("logkit", { timeout: 10_000 });
  });

  test("package page shows install snippet and version provenance", async ({ page }) => {
    await page.goto(`${WEB_URL}/p/acme/http-kit`);
    await expect(page.locator(".snippet")).toContainText("zed add acme/http-kit");
    const versions = page.locator("table.versions");
    await expect(versions).toContainText("1.2.0");
    // Short commit sha + vcs tag columns are the provenance record.
    await expect(versions).toContainText("tag v1.2.0");
  });

  test("package name links from the home list to the package page", async ({ page }) => {
    await page.goto(`${WEB_URL}/`);
    await page.locator('.pkg-name', { hasText: "cryptobox" }).first().click();
    await expect(page).toHaveURL(/\/p\/acme\/cryptobox/);
    await expect(page.locator(".snippet")).toContainText("zed add acme/cryptobox");
  });

  test("responses carry the security headers", async ({ page }) => {
    const res = await page.goto(`${WEB_URL}/`);
    const headers = res!.headers();
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
  });

  test("unknown package page does not 500", async ({ page }) => {
    const res = await page.goto(`${WEB_URL}/p/acme/nope`);
    expect(res!.status()).toBeLessThan(500);
  });
});
