import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const framework = process.env.E2E_FRAMEWORK;
const artifactRoot = path.resolve(
  process.env.RELEASE_REPORT_ARTIFACT_DIR ?? path.join(process.cwd(), 'artifacts', framework ?? 'unknown'),
);
const reportPath = path.join(artifactRoot, 'release-plan.html');
const planPath = path.join(artifactRoot, 'release-plan.json');
const integrityPath = path.join(artifactRoot, 'release-plan.integrity.json');
const candidateRoot = path.resolve(process.env.ZED_CLI_CANDIDATE ?? '');
const reportUrl = pathToFileURL(reportPath).href;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function writeEvidence(name, value, encoding = 'utf8') {
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(artifactRoot, name), value, encoding);
}

function isExternalUrl(raw) {
  try {
    const url = new URL(raw);
    return !['file:', 'data:', 'blob:', 'about:'].includes(url.protocol);
  } catch {
    return true;
  }
}

async function assertArtifactIntegrity() {
  const [planSource, reportSource, integritySource] = await Promise.all([
    readFile(planPath, 'utf8'),
    readFile(reportPath, 'utf8'),
    readFile(integrityPath, 'utf8'),
  ]);
  const plan = JSON.parse(planSource);
  const integrity = JSON.parse(integritySource);
  assert.equal(integrity.schema, 'zed-release-plan-report-integrity/v1');
  assert.equal(integrity.algorithm, 'sha256');
  assert.equal(integrity.plan.file, path.basename(planPath));
  assert.equal(integrity.report.file, path.basename(reportPath));
  assert.equal(sha256(reportSource), integrity.report.sha256);

  const moduleUrl = pathToFileURL(
    path.join(candidateRoot, 'scripts', 'release-plan-integrity.mjs'),
  ).href;
  const integrityModule = await import(moduleUrl);
  assert.equal(integrityModule.releasePlanDigest(plan), integrity.plan.canonical_sha256);

  const meta = reportSource.match(
    /<meta name="zed-release-plan-sha256" content="([0-9a-f]{64})">/,
  )?.[1];
  const visible = reportSource.match(
    /<li data-plan-sha256><strong>Plan SHA-256<\/strong><code>([0-9a-f]{64})<\/code><\/li>/,
  )?.[1];
  assert.equal(meta, integrity.plan.canonical_sha256);
  assert.equal(visible, integrity.plan.canonical_sha256);
  return integrity;
}

function assertSnapshot(snapshot, expectedDigest) {
  assert.equal(snapshot.title, 'acme/sdk@1.2.3 — Zed release plan');
  assert.equal(snapshot.metaDigest, expectedDigest);
  assert.equal(snapshot.visibleDigest, expectedDigest);
  assert.equal(snapshot.total, '5');
  assert.deepEqual(snapshot.counts, ['2', '2', '1']);
  assert.equal(snapshot.rows, 5);
  assert.equal(snapshot.captions, 3);
  assert.equal(snapshot.filterLabel, 'Filter artifacts');
}

const browserSnapshot = `(() => {
  const digest = document.querySelector('meta[name="zed-release-plan-sha256"]')?.content ?? null;
  return {
    title: document.title,
    metaDigest: digest,
    visibleDigest: document.querySelector('[data-plan-sha256] code')?.textContent ?? null,
    total: document.querySelector('[data-total-count]')?.textContent ?? null,
    counts: [...document.querySelectorAll('[data-count-kind] span')].map((node) => node.textContent),
    rows: document.querySelectorAll('tbody tr[data-search]').length,
    captions: document.querySelectorAll('table caption').length,
    filterLabel: document.querySelector('label[for="artifact-filter"]')?.textContent?.trim() ?? null,
  };
})()`;

async function runPlaywright(expectedDigest) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const browserErrors = [];
  const externalRequests = [];
  page.on('console', (message) => message.type() === 'error' && browserErrors.push(`console: ${message.text()}`));
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('request', (request) => isExternalUrl(request.url()) && externalRequests.push(request.url()));
  try {
    await page.goto(reportUrl, { waitUntil: 'load', timeout: 15_000 });
    assertSnapshot(await page.evaluate(browserSnapshot), expectedDigest);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('skip-link')), true);
    const filter = page.locator('#artifact-filter');
    await filter.fill('npmjs');
    assert.equal(await page.locator('tbody tr[data-search]:visible').count(), 1);
    await filter.press('Escape');
    assert.equal(await page.locator('tbody tr[data-search]:visible').count(), 5);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    assert.deepEqual(browserErrors, []);
    assert.deepEqual(externalRequests, []);
  } finally {
    await Promise.allSettled([
      page.screenshot({ path: path.join(artifactRoot, 'playwright.png'), fullPage: true }),
      writeEvidence('playwright-errors.json', JSON.stringify(browserErrors, null, 2)),
      writeEvidence('playwright-external-requests.json', JSON.stringify(externalRequests, null, 2)),
    ]);
    await browser.close().catch(() => {});
  }
}

async function runPuppeteer(expectedDigest) {
  const { default: puppeteer } = await import('puppeteer');
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  assert(executablePath, 'PUPPETEER_EXECUTABLE_PATH must identify Chrome');
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const browserErrors = [];
  const externalRequests = [];
  page.on('console', (message) => message.type() === 'error' && browserErrors.push(`console: ${message.text()}`));
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('request', (request) => isExternalUrl(request.url()) && externalRequests.push(request.url()));
  try {
    await page.goto(reportUrl, { waitUntil: 'load', timeout: 15_000 });
    assertSnapshot(await page.evaluate(browserSnapshot), expectedDigest);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('skip-link')), true);
    await page.type('#artifact-filter', 'npmjs');
    assert.equal(
      await page.$$eval('tbody tr[data-search]', (rows) => rows.filter((row) => !row.hidden).length),
      1,
    );
    await page.focus('#artifact-filter');
    await page.keyboard.press('Escape');
    assert.equal(
      await page.$$eval('tbody tr[data-search]', (rows) => rows.filter((row) => !row.hidden).length),
      5,
    );
    await page.setViewport({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    assert.deepEqual(browserErrors, []);
    assert.deepEqual(externalRequests, []);
  } finally {
    await Promise.allSettled([
      page.screenshot({ path: path.join(artifactRoot, 'puppeteer.png'), fullPage: true }),
      writeEvidence('puppeteer-errors.json', JSON.stringify(browserErrors, null, 2)),
      writeEvidence('puppeteer-external-requests.json', JSON.stringify(externalRequests, null, 2)),
    ]);
    await browser.close().catch(() => {});
  }
}

async function runSelenium(expectedDigest) {
  const [webdriverModule, chromeModule, loggingModule] = await Promise.all([
    import('selenium-webdriver'),
    import('selenium-webdriver/chrome.js'),
    import('selenium-webdriver/lib/logging.js'),
  ]);
  const { Builder, By, Key } = webdriverModule;
  const chrome = chromeModule.default ?? chromeModule;
  const logging = loggingModule.default ?? loggingModule;
  const preferences = new logging.Preferences();
  preferences.setLevel(logging.Type.BROWSER, logging.Level.ALL);
  preferences.setLevel(logging.Type.PERFORMANCE, logging.Level.ALL);
  const options = new chrome.Options();
  options.addArguments(
    '--headless=new',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1280,800',
  );
  const driver = await new Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .setLoggingPrefs(preferences)
    .build();
  const browserErrors = [];
  const externalRequests = [];
  try {
    await driver.manage().setTimeouts({ implicit: 0, pageLoad: 15_000, script: 15_000 });
    await driver.get(reportUrl);
    assertSnapshot(await driver.executeScript(`return ${browserSnapshot};`), expectedDigest);
    await driver.actions().sendKeys(Key.TAB).perform();
    assert.equal(
      await driver.executeScript("return document.activeElement?.classList.contains('skip-link') === true;"),
      true,
    );
    const filter = await driver.findElement(By.id('artifact-filter'));
    await filter.sendKeys('npmjs');
    assert.equal(
      await driver.executeScript("return [...document.querySelectorAll('tbody tr[data-search]')].filter((row) => !row.hidden).length;"),
      1,
    );
    await filter.sendKeys(Key.ESCAPE);
    assert.equal(
      await driver.executeScript("return [...document.querySelectorAll('tbody tr[data-search]')].filter((row) => !row.hidden).length;"),
      5,
    );
    await driver.manage().window().setRect({ width: 390, height: 844 });
    assert.equal(
      await driver.executeScript('return document.documentElement.scrollWidth <= window.innerWidth;'),
      true,
    );

    const browserEntries = await driver.manage().logs().get(logging.Type.BROWSER);
    browserErrors.push(
      ...browserEntries
        .filter((entry) => entry.level.value >= logging.Level.SEVERE.value)
        .map((entry) => `${entry.level.name}: ${entry.message}`),
    );
    const performanceEntries = await driver.manage().logs().get(logging.Type.PERFORMANCE);
    for (const entry of performanceEntries) {
      try {
        const event = JSON.parse(entry.message).message;
        if (event.method !== 'Network.requestWillBeSent') continue;
        const url = event.params?.request?.url;
        if (url && isExternalUrl(url)) externalRequests.push(url);
      } catch {
        // Ignore non-network performance records.
      }
    }
    assert.deepEqual(browserErrors, []);
    assert.deepEqual(externalRequests, []);
  } finally {
    await Promise.allSettled([
      driver.takeScreenshot().then((png) => writeEvidence('selenium.png', png, 'base64')),
      writeEvidence('selenium-errors.json', JSON.stringify(browserErrors, null, 2)),
      writeEvidence('selenium-external-requests.json', JSON.stringify(externalRequests, null, 2)),
    ]);
    await driver.quit().catch(() => {});
  }
}

test('bound release report is independently consumable', { timeout: 60_000 }, async () => {
  assert(['playwright', 'puppeteer', 'selenium'].includes(framework));
  assert(candidateRoot && candidateRoot !== path.parse(candidateRoot).root);
  const integrity = await assertArtifactIntegrity();
  if (framework === 'playwright') await runPlaywright(integrity.plan.canonical_sha256);
  else if (framework === 'puppeteer') await runPuppeteer(integrity.plan.canonical_sha256);
  else await runSelenium(integrity.plan.canonical_sha256);
});
