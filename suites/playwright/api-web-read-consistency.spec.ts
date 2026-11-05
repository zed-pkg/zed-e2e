// Concurrent client -> API and client -> web round-trips against one real
// seeded local registry database. This is cross-surface consistency, not a
// mocked gateway or a claim that the web tier calls the HTTP API internally.
import { expect, test } from '@playwright/test';
import { API_URL, WEB_URL } from '../../harness/stack.js';
import { ensureSeeded } from '../../harness/fixtures.js';

test.describe('registry API / server-rendered web read consistency', () => {
  test.beforeAll(async () => {
    await ensureSeeded();
  });

  test('concurrent clients see the same published package and version', async ({ request }) => {
    const pairs = await Promise.all(Array.from({ length: 12 }, async () => {
      const [api, web] = await Promise.all([
        request.get(API_URL + '/v1/packages/acme/http-kit', { timeout: 10_000 }),
        request.get(WEB_URL + '/p/acme/http-kit', { timeout: 10_000 }),
      ]);
      expect(api.status()).toBe(200);
      expect(web.status()).toBe(200);
      const metadata = await api.json();
      const html = await web.text();
      return { metadata, html };
    }));

    for (const { metadata, html } of pairs) {
      expect(metadata.org).toBe('acme');
      expect(metadata.name).toBe('http-kit');
      expect(metadata.versions).toContain('1.2.0');
      expect(metadata.latest).toBe('1.2.0');
      expect(html).toContain('zed add acme/http-kit');
      expect(html).toContain(metadata.latest);
      expect(html).not.toMatch(/(?:Bearer|zpkg_)[a-zA-Z0-9_-]{24,}/);
    }
  });

  test('unknown package responses are bounded and isolated on both tiers', async ({ request }) => {
    const unknown = 'not-installed-e2e-read-only';
    const pairs = await Promise.all(Array.from({ length: 8 }, () => Promise.all([
      request.get(API_URL + '/v1/packages/acme/' + unknown, { timeout: 10_000 }),
      request.get(WEB_URL + '/p/acme/' + unknown, { timeout: 10_000 }),
    ])));
    for (const [api, web] of pairs) {
      expect(api.status()).toBe(404);
      expect(web.status()).toBeLessThan(500);
      expect((await api.text()).length).toBeLessThan(8192);
      expect((await web.text()).length).toBeLessThan(100_000);
    }
    const health = await request.get(API_URL + '/healthz', { timeout: 5_000 });
    expect(health.status()).toBe(200);
  });
});
