import { test, expect } from "@playwright/test";
import { WEB_URL, API_URL } from "../../harness/stack.js";
import { ensurePolyglotSeeded, POLYGLOT_SEED } from "../../harness/fixtures.js";

/**
 * Polyglot publishing, seen from a browser.
 *
 * The zed-cli `polyglot` workflow proves the *artifacts* are well-formed —
 * isolated, test-free, natively publishable. It never puts them in a registry
 * a human navigates. These specs cover the other half: one `zed publish` of a
 * multi-language repository must leave the registry in a state where a
 * consumer of any single language can find and install exactly their package.
 *
 * The decisive property (zed-docs doc 17) is that a Go consumer downloads Go
 * bytes. In the UI that means the language packages are genuinely separate
 * pages with their own install snippets — not one page a consumer has to
 * reach into.
 */
const { base, repositoryTarget, targets } = POLYGLOT_SEED;
const languageNames = targets.map((t) => t.name ?? `${base.name}-${t.key}`);

test.describe("polyglot fan-out in the registry UI", () => {
  test.beforeAll(async () => {
    await ensurePolyglotSeeded();
  });

  test("one publish produced a separate page per language", async ({ page }) => {
    for (const name of languageNames) {
      const response = await page.goto(`${WEB_URL}/p/${base.org}/${name}`);
      expect(response?.status(), `${name} should have its own package page`).toBe(200);
      // The install snippet is the consumer-facing contract: it must name THIS
      // language package, not the polyglot source repo.
      await expect(page.locator(".snippet")).toContainText(`zed add ${base.org}/${name}`);
    }
  });

  test("the whole-repository artifact is published alongside the slices", async ({ page }) => {
    // `[targets.repository] dir = "."` is the goal-2 surface: the entire repo
    // as one package, coexisting with the isolated language packages rather
    // than replacing them.
    const response = await page.goto(`${WEB_URL}/p/${base.org}/${repositoryTarget}`);
    expect(response?.status()).toBe(200);
    await expect(page.locator(".snippet")).toContainText(`zed add ${base.org}/${repositoryTarget}`);
  });

  test("the polyglot source name is NOT itself a package", async ({ page }) => {
    // `acme-clients` is the repository, not a published artifact: the fan-out
    // publishes `acme-clients-<target>` and the explicit repository target.
    // If the source name resolved, consumers could depend on a package whose
    // contents are undefined.
    const response = await page.goto(`${WEB_URL}/p/${base.org}/${base.name}`);
    expect(response?.status()).toBe(404);
  });

  test("every language package shares one version and one provenance tag", async ({ page }) => {
    // Lockstep versioning is the point of a single-manifest polyglot repo: a
    // consumer reading one changelog can reason about every language.
    for (const name of languageNames) {
      await page.goto(`${WEB_URL}/p/${base.org}/${name}`);
      const versions = page.locator("table.versions");
      await expect(versions, `${name} should list ${base.version}`).toContainText(base.version);
      await expect(versions, `${name} should carry the repo tag`).toContainText(`tag v${base.version}`);
    }
  });

  test("searching the repo name surfaces every language sibling", async ({ page }) => {
    // A consumer who knows the library but not zed's naming convention has to
    // be able to discover which languages exist.
    await page.goto(`${WEB_URL}/search`);
    await page.fill("#q", base.name);
    const results = page.locator("#results");
    for (const name of languageNames) {
      await expect(results, `search should surface ${name}`).toContainText(name, { timeout: 10_000 });
    }
  });

  test("each language package is independently resolvable over the API", async ({ request }) => {
    // The UI is a projection of the API; assert the contract underneath it so
    // a UI regression and a registry regression stay distinguishable.
    for (const name of languageNames) {
      const res = await request.get(`${API_URL}/v1/packages/${base.org}/${name}`);
      expect(res.status(), `${name} should resolve`).toBe(200);
      const body = await res.json();
      expect(body.name).toBe(name);
      expect(body.versions).toContain(base.version);
    }
  });

  test("language packages are distinct artifacts, not aliases", async ({ request }) => {
    // The whole argument for publishing per language is that a consumer
    // downloads only their language's bytes. Identical digests would mean the
    // registry is serving one fat artifact under several names.
    const digests = new Map<string, string>();
    for (const name of languageNames) {
      const res = await request.get(`${API_URL}/v1/packages/${base.org}/${name}/versions/${base.version}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.sha256, `${name} should report a digest`).toBeTruthy();
      digests.set(name, body.sha256);
    }
    const unique = new Set(digests.values());
    expect(
      unique.size,
      `each language slice must be its own artifact, got: ${JSON.stringify([...digests])}`,
    ).toBe(languageNames.length);
  });
});
