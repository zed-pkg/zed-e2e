import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Builder, By, until, type WebDriver } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import { startStack, stopStack, WEB_URL } from "../../harness/stack.js";
import { ensureSeeded } from "../../harness/fixtures.js";

// Third independent engine: Selenium WebDriver (chromedriver). Verifies the
// same UI through the W3C WebDriver protocol rather than CDP, so a
// browser-automation regression can't slip past all three frameworks.
let driver: WebDriver;

before(async () => {
  await startStack();
  await ensureSeeded();
  // Assign before chaining: addArguments() is typed to return the base
  // chromium Options, so keeping `options` as the declared chrome.Options
  // avoids the @types subtype mismatch on setChromeOptions.
  const options = new chrome.Options();
  options.addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage");
  // Remote-browser support (doc 13): point at a remote Selenium Grid via
  // SELENIUM_REMOTE_URL, else drive a local chromedriver.
  const builder = new Builder().forBrowser("chrome").setChromeOptions(options);
  if (process.env.SELENIUM_REMOTE_URL) builder.usingServer(process.env.SELENIUM_REMOTE_URL);
  driver = await builder.build();
});

after(async () => {
  await driver?.quit();
  await stopStack();
});

test("home page renders the recency list", async () => {
  await driver.get(`${WEB_URL}/`);
  await driver.wait(until.elementLocated(By.css(".pkg-list")), 10_000);
  // Registry-state-agnostic (the recent list caps at 20): assert the feature
  // renders >=1 entry, not a specific seed. Seeds are asserted by name in the
  // search + package-page tests below.
  const names = await driver.findElements(By.css(".pkg-name"));
  assert.ok(names.length >= 1, "home page should list at least one recent package");
});

test("HTMX live search returns matches", async () => {
  await driver.get(`${WEB_URL}/search`);
  const input = await driver.wait(until.elementLocated(By.css("#q")), 10_000);
  await input.sendKeys("logkit");
  await driver.wait(async () => {
    const results = await driver.findElement(By.css("#results"));
    return (await results.getText()).includes("logkit");
  }, 10_000);
  const results = await driver.findElement(By.css("#results"));
  assert.match(await results.getText(), /logkit/);
});

test("package page renders the install snippet and versions", async () => {
  await driver.get(`${WEB_URL}/p/acme/http-kit`);
  const snippet = await driver.wait(until.elementLocated(By.css(".snippet")), 10_000);
  assert.match(await snippet.getText(), /zed add acme\/http-kit/);
  const versions = await driver.findElement(By.css("table.versions"));
  assert.match(await versions.getText(), /1\.2\.0/);
});
