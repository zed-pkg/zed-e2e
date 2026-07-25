import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { startStack, stopStack, WEB_URL } from "../../harness/stack.js";
import { ensureSeeded } from "../../harness/fixtures.js";

// Drives the Rust web server in raw Chromium via Puppeteer — a second,
// independent browser engine check of the same MASH + HTMX UI.
let browser: Browser;
let page: Page;

before(async () => {
  await startStack();
  await ensureSeeded();
  // Remote-browser support (doc 13): connect to a browser deployed in a grid on
  // the ORES clusters via its CDP/ws endpoint (PUPPETEER_BROWSER_WS), else
  // launch a local Chromium.
  const ws = process.env.PUPPETEER_BROWSER_WS;
  browser = ws
    ? await puppeteer.connect({ browserWSEndpoint: ws })
    : await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
  await stopStack();
});

test("home page renders the registry and its recency list", async () => {
  await page.goto(`${WEB_URL}/`, { waitUntil: "networkidle0" });
  const brand = await page.$eval(".brand", (el) => el.textContent ?? "");
  assert.match(brand, /zed/);
  // Registry-state-agnostic: the home page caps the "recently published" list
  // at 20, so assert the FEATURE renders >=1 entry rather than a specific seed
  // (seeds are asserted by name in the search + package-page tests below).
  const count = await page.$$eval(".pkg-name", (els) => els.length);
  assert.ok(count >= 1, "home page should list at least one recent package");
});

test("HTMX search swaps results into #results", async () => {
  await page.goto(`${WEB_URL}/search`, { waitUntil: "networkidle0" });
  await page.type("#q", "cryptobox");
  await page.waitForFunction(
    () => (document.querySelector("#results")?.textContent ?? "").includes("cryptobox"),
    { timeout: 10_000 },
  );
  const results = await page.$eval("#results", (el) => el.textContent ?? "");
  assert.match(results, /cryptobox/);
});

test("package page shows the install snippet", async () => {
  await page.goto(`${WEB_URL}/p/acme/logkit`, { waitUntil: "networkidle0" });
  const snippet = await page.$eval(".snippet", (el) => el.textContent ?? "");
  assert.match(snippet, /zed add acme\/logkit/);
});

test("security headers are present (CSP, nosniff, frame-options)", async () => {
  const res = await page.goto(`${WEB_URL}/`, { waitUntil: "domcontentloaded" });
  const headers = res!.headers();
  assert.match(headers["content-security-policy"] ?? "", /default-src 'self'/);
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["x-frame-options"], "DENY");
});
