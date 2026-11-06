// An E2E race across two real registry tenants: CLI-published artifacts,
// independently scoped owners, concurrent foreign writers, and immutable
// content-addressed downloads.
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { API_URL, createToken } from '../../harness/stack.js';
import { publishFixture } from '../../harness/fixtures.js';

const suffix = Date.now().toString(36);
const orgs = ['isolation-a-' + suffix, 'isolation-b-' + suffix] as const;
const version = '1.0.0';
const packageName = 'immutable-under-race';

test.describe('cross-tenant registry mutation races are fail-closed', () => {
  const owners: string[] = [];

  test.beforeAll(async () => {
    for (const org of orgs) {
      const owner = await createToken(org + '-owner', org, 'owner');
      owners.push(owner);
      await publishFixture({
        org,
        name: packageName,
        version,
        description: 'read-only cross-tenant race fixture ' + org,
      }, { token: owner });
    }
  });

  test('foreign yanks cannot race an authorized change or corrupt either stored artifact',
    async ({ request }) => {
      const metadataURL = (org: string) =>
        API_URL + '/v1/packages/' + org + '/' + packageName + '/versions/' + version;
      const yankURL = (org: string) => metadataURL(org) + '/yank';
      const originals = await Promise.all(orgs.map(async org => {
        const response = await request.get(metadataURL(org));
        expect(response.status()).toBe(200);
        const meta = await response.json() as { sha256: string; size: number; yanked: boolean };
        expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(meta.yanked).toBe(false);
        return meta;
      }));

      const yank = (org: string, token: string, yanked: boolean) =>
        request.post(yankURL(org), {
          headers: { authorization: 'Bearer ' + token },
          data: { yanked },
        });

      try {
        const crossTenantCalls = Array.from({ length: 16 }, (_, index) => {
          const target = index % 2;
          const other = 1 - target;
          return yank(orgs[target], owners[other], true);
        });
        const [foreign, own] = await Promise.all([
          Promise.all(crossTenantCalls),
          Promise.all(orgs.map((org, index) => yank(org, owners[index], true))),
        ]);
        for (const response of foreign) {
          expect([401, 403]).toContain(response.status());
          const body = await response.text();
          expect(body.length).toBeLessThan(4096);
          for (const token of owners) expect(body).not.toContain(token);
        }
        for (const response of own) expect(response.status()).toBe(200);

        for (const [index, org] of orgs.entries()) {
          const result = await request.get(metadataURL(org));
          expect(result.status()).toBe(200);
          const meta = await result.json();
          expect(meta.yanked, 'only the own owner can yank').toBe(true);
          expect(meta.sha256).toBe(originals[index].sha256);
        }
      } finally {
        // Do not leave intentionally yanked packages in a reused CI registry.
        const restores = await Promise.all(orgs.map((org, index) =>
          yank(org, owners[index], false)));
        for (const response of restores) expect(response.status()).toBe(200);
      }

      for (const [index, org] of orgs.entries()) {
        const result = await request.get(metadataURL(org));
        expect(result.status()).toBe(200);
        const meta = await result.json();
        expect(meta.yanked).toBe(false);
        expect(meta.sha256).toBe(originals[index].sha256);
        const download = await request.get(API_URL + '/v1/artifacts/' + meta.sha256);
        expect(download.status()).toBe(200);
        const bytes = await download.body();
        expect(bytes.length).toBe(originals[index].size);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(meta.sha256);
      }
    });
});
