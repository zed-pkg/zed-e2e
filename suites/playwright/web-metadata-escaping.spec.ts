// Real CLI publish -> Rust API persistence -> Rust SSR -> Chromium/Firefox
// presentation of attacker-controlled package descriptions. This is distinct
// from the artifact MIME/CSP tests: metadata itself must remain inert.
import { test, expect } from '@playwright/test';
import { createToken, WEB_URL } from '../../harness/stack.js';
import { publishFixture } from '../../harness/fixtures.js';

const org = 'metadata-inert-' + Date.now().toString(36);
const name = 'html-description';
const description = '<img src=x onerror=window.__zedMetadataExecuted=1>';

test.describe('registry package metadata remains inert across CLI, API and browser', () => {
  test.beforeAll(async () => {
    const token = await createToken(org + '-publisher', org);
    await publishFixture({
      org,
      name,
      version: '1.0.0',
      description,
    }, { token });
  });

  test('stored markup is visible as description text, not a DOM element or event handler',
    async ({ page, request }) => {
      const destination = WEB_URL + '/p/' + org + '/' + name;
      const response = await request.get(destination);
      expect(response.status()).toBe(200);
      const raw = await response.text();
      expect(raw).toContain('&lt;img');
      expect(raw).not.toContain(description);

      await page.goto(destination);
      const lede = page.locator('.lede');
      await expect(lede).toContainText(description);
      expect(await lede.locator('img').count()).toBe(0);
      expect(await page.evaluate(() =>
        (window as unknown as { __zedMetadataExecuted?: number }).__zedMetadataExecuted),
      ).toBeUndefined();
    });

  test('HTMX search stays inert when it renders the same persisted description',
    async ({ page }) => {
      await page.goto(WEB_URL + '/search');
      await page.fill('#q', name);
      const results = page.locator('#results');
      await expect(results).toContainText(name, { timeout: 10_000 });
      const descriptionElement = results.locator('.pkg-desc').filter({ hasText: description }).first();
      await expect(descriptionElement).toContainText(description);
      expect(await descriptionElement.locator('img').count()).toBe(0);
      expect(await page.evaluate(() =>
        (window as unknown as { __zedMetadataExecuted?: number }).__zedMetadataExecuted),
      ).toBeUndefined();
    });
});
