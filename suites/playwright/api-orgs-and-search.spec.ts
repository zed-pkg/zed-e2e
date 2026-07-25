import { test, expect } from "@playwright/test";
import { API_URL } from "../../harness/stack.js";
import { ensureSeeded, SEED } from "../../harness/fixtures.js";

// The org-namespace endpoint's method/auth contract and the search endpoint's
// query semantics (browse, name/description matching, injection-safe wildcards,
// and the response shape). The happy-path package/version reads live in
// api-contract; this pins orgs + the fuller search behavior.
test.describe("zed-api-server orgs + search", () => {
  test.beforeAll(async () => {
    await ensureSeeded();
  });

  test("GET /v1/orgs is method-not-allowed (org creation is POST-only)", async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/orgs`);
    expect(res.status()).toBe(405);
    expect((res.headers()["allow"] ?? "").toUpperCase()).toContain("POST");
  });

  test("POST /v1/orgs without a token is rejected", async ({ request }) => {
    const res = await request.post(`${API_URL}/v1/orgs`, { data: { slug: `unauth-${Date.now().toString(36)}` } });
    expect([401, 403]).toContain(res.status());
  });

  test("search returns a {query, items[]} envelope echoing the query", async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/search`, { params: { q: "kit" } });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/json");
    const body = await res.json();
    expect(body.query).toBe("kit");
    expect(Array.isArray(body.items)).toBe(true);
  });

  test("each search item carries exactly org, name, description, latest", async ({ request }) => {
    const body = await (await request.get(`${API_URL}/v1/search`, { params: { q: "kit" } })).json();
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(["description", "latest", "name", "org"]);
      expect(typeof item.latest).toBe("string");
    }
  });

  test("search matches package NAME substrings (http-kit and logkit share 'kit')", async ({ request }) => {
    const body = await (await request.get(`${API_URL}/v1/search`, { params: { q: "kit" } })).json();
    const names = body.items.map((i: { name: string }) => i.name);
    expect(names).toContain("http-kit");
    expect(names).toContain("logkit");
  });

  test("search matches DESCRIPTION words too (logkit's 'logging')", async ({ request }) => {
    const body = await (await request.get(`${API_URL}/v1/search`, { params: { q: "logging" } })).json();
    const names = body.items.map((i: { name: string }) => i.name);
    expect(names).toContain("logkit");
  });

  test("an empty query browses the catalogue rather than erroring", async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/search`, { params: { q: "" } });
    expect(res.status()).toBe(200);
    const names = (await res.json()).items.map((i: { name: string }) => i.name);
    // The seed packages are all browseable without a query term.
    for (const pkg of SEED.packages) expect(names).toContain(pkg.name);
  });

  test("LIKE wildcards are treated literally, not as SQL wildcards", async ({ request }) => {
    // Neither "%" (match-all) nor "_" (match-any-char) may leak into the LIKE.
    for (const q of ["%", "_", "%kit%", "ki_"]) {
      const body = await (await request.get(`${API_URL}/v1/search`, { params: { q } })).json();
      const names = body.items.map((i: { name: string }) => i.name);
      // A literal "ki_" / "%kit%" matches no real package name, and "%"/"_" alone
      // must not match everything.
      expect(names).not.toContain("http-kit");
    }
  });

  test("a no-match query returns an empty item list (not an error)", async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/search`, { params: { q: "zzz-nothing-zzz-2718281828" } });
    expect(res.status()).toBe(200);
    expect((await res.json()).items).toEqual([]);
  });
});
