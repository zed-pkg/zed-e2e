import { test, expect } from "@playwright/test";
import { API_URL, createToken } from "../../harness/stack.js";
import { publishFixture } from "../../harness/fixtures.js";

// Yank visibility rules: a yanked version disappears from resolution/search but
// stays downloadable for existing lockfiles, and GET version still reports it
// with yanked:true. Restore (yanked:false) brings it back.
test.describe("zed-api-server yank semantics", () => {
  const org = `yank-${Date.now().toString(36)}`;
  let token: string;

  test.beforeAll(async () => {
    token = await createToken(`${org}-owner`, org);
    await publishFixture({ org, name: "widget", version: "1.0.0", description: "yank fixture" }, { token, allowExisting: true });
    await publishFixture({ org, name: "widget", version: "1.1.0", description: "yank fixture" }, { token, allowExisting: true });
  });

  const yank = (version: string, yanked: boolean, request: import("@playwright/test").APIRequestContext) =>
    request.post(`${API_URL}/v1/packages/${org}/widget/versions/${version}/yank`, {
      headers: { authorization: `Bearer ${token}` },
      data: { yanked },
    });

  test("yanking hides the version from package metadata and latest", async ({ request }) => {
    expect((await yank("1.1.0", true, request)).status()).toBe(200);

    const pkg = await (await request.get(`${API_URL}/v1/packages/${org}/widget`)).json();
    expect(pkg.versions).not.toContain("1.1.0");
    expect(pkg.versions).toContain("1.0.0");
    expect(pkg.latest).toBe("1.0.0");
  });

  test("GET version still returns a yanked version, flagged", async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/packages/${org}/widget/versions/1.1.0`);
    expect(res.status()).toBe(200);
    expect((await res.json()).yanked).toBe(true);
  });

  test("search excludes yanked versions from latest", async ({ request }) => {
    const body = await (await request.get(`${API_URL}/v1/search`, { params: { q: "widget" } })).json();
    const hit = body.items.find((i: { org: string; name: string }) => i.org === org && i.name === "widget");
    if (hit?.latest) expect(hit.latest).toBe("1.0.0");
  });

  test("restoring (yanked:false) makes the version resolvable again", async ({ request }) => {
    expect((await yank("1.1.0", false, request)).status()).toBe(200);
    const pkg = await (await request.get(`${API_URL}/v1/packages/${org}/widget`)).json();
    expect(pkg.versions).toContain("1.1.0");
    expect(pkg.latest).toBe("1.1.0");
  });

  test("yanking an unknown version is a 404", async ({ request }) => {
    expect((await yank("7.7.7", true, request)).status()).toBe(404);
  });
});
