import { test, expect } from "@playwright/test";
import { API_URL, createToken } from "../../harness/stack.js";
import { ensureSeeded, publishFixture } from "../../harness/fixtures.js";

// Authorization boundaries on the mutating endpoints (publish / yank). The
// happy paths live in api-contract + cli-lifecycle; this file pins the
// REJECTIONS, which are the security-relevant half.
test.describe("zed-api-server authorization", () => {
  // A dedicated org + package so a hypothetical successful (buggy) yank can
  // never corrupt the shared seed dataset other suites assert against.
  const org = `auth-victim-${Date.now().toString(36)}`;
  const pkg = { org, name: "guarded", version: "1.0.0", description: "auth boundary fixture" };

  test.beforeAll(async () => {
    await ensureSeeded();
    const token = await createToken(`${org}-owner`, org);
    await publishFixture(pkg, { token, allowExisting: true });
  });

  const yankUrl = `${API_URL}/v1/packages/${org}/guarded/versions/1.0.0/yank`;

  test("yank without a token is rejected", async ({ request }) => {
    const res = await request.post(yankUrl, { data: { yanked: true } });
    expect([401, 403]).toContain(res.status());
  });

  test("yank with a malformed bearer token is rejected", async ({ request }) => {
    const res = await request.post(yankUrl, {
      headers: { authorization: "Bearer not-a-real-token" },
      data: { yanked: true },
    });
    expect([401, 403]).toContain(res.status());
  });

  test("yank with an unknown well-formed token is rejected", async ({ request }) => {
    const res = await request.post(yankUrl, {
      headers: { authorization: "Bearer zpkg_deadbeefdeadbeefdeadbeefdeadbeef" },
      data: { yanked: true },
    });
    expect([401, 403]).toContain(res.status());
  });

  test("a token scoped to another org cannot yank this org", async ({ request }) => {
    const outsider = await createToken("outsider", `auth-outsider-${Date.now().toString(36)}`);
    const res = await request.post(yankUrl, {
      headers: { authorization: `Bearer ${outsider}` },
      data: { yanked: true },
    });
    expect([401, 403]).toContain(res.status());

    // And the version is still live — the rejected yank changed nothing.
    const check = await request.get(`${API_URL}/v1/packages/${org}/guarded/versions/1.0.0`);
    expect(check.status()).toBe(200);
    expect((await check.json()).yanked).toBeFalsy();
  });

  test("a token scoped to another org cannot publish into this org", async () => {
    const outsiderOrg = `auth-outsider2-${Date.now().toString(36)}`;
    const token = await createToken("outsider2", outsiderOrg);
    // publishFixture publishes into pkg.org (this protected org) using the
    // outsider's token -> the server must refuse.
    await expect(
      publishFixture({ ...pkg, version: "9.9.9", name: "intruder" }, { token }),
    ).rejects.toThrow();
  });
});
