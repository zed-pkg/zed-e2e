import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { startStack, stopStack, WEB_URL } from "../../harness/stack.js";
import { ensurePolyglotSeeded, POLYGLOT_SEED } from "../../harness/fixtures.js";

// Second-engine check of the polyglot fan-out in the registry UI. The
// Playwright suite covers the same properties in depth; this exists because
// the package page's install snippet and version table are the consumer-facing
// contract for a language slice, and a rendering regression that only shows up
// in raw Chromium would otherwise ship.
const { base, repositoryTarget, targets } = POLYGLOT_SEED;
const languageNames = targets.map((t) => t.name ?? `${base.name}-${t.key}`);

let browser: Browser;
let page: Page;

before(async () => {
  await startStack();
  await ensurePolyglotSeeded();
  const ws = process.env.PUPPETEER_BROWSER_WS;
  browser = ws
    ? await puppeteer.connect({ browserWSEndpoint: ws })
    : await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  page = await browser.newPage();
});

after(async () => {
  if (process.env.PUPPETEER_BROWSER_WS) await browser?.disconnect();
  else await browser?.close();
  await stopStack();
});

test("each language slice has its own page and install snippet", async () => {
  for (const name of languageNames) {
    const response = await page.goto(`${WEB_URL}/p/${base.org}/${name}`, {
      waitUntil: "networkidle0",
    });
    assert.equal(response?.status(), 200, `${name} should have its own package page`);
    const snippet = await page.$eval(".snippet", (el) => el.textContent ?? "");
    assert.match(
      snippet,
      new RegExp(`zed add ${base.org}/${name}\\b`),
      `${name} install snippet should name this language package`,
    );
  }
});

test("the whole-repository artifact coexists with the slices", async () => {
  const response = await page.goto(`${WEB_URL}/p/${base.org}/${repositoryTarget}`, {
    waitUntil: "networkidle0",
  });
  assert.equal(response?.status(), 200);
  const snippet = await page.$eval(".snippet", (el) => el.textContent ?? "");
  assert.match(snippet, new RegExp(`zed add ${base.org}/${repositoryTarget}\\b`));
});

test("every slice reports the same lockstep version", async () => {
  for (const name of languageNames) {
    await page.goto(`${WEB_URL}/p/${base.org}/${name}`, { waitUntil: "networkidle0" });
    const versions = await page.$eval("table.versions", (el) => el.textContent ?? "");
    assert.ok(
      versions.includes(base.version),
      `${name} should list ${base.version}, got: ${versions.slice(0, 200)}`,
    );
  }
});
