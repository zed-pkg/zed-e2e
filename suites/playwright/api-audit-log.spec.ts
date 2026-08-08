import { test, expect } from "@playwright/test";
import { API_URL, createAdminToken, createToken } from "../../harness/stack.js";
import { publishFixture } from "../../harness/fixtures.js";

// Audit trail (zed-docs issue #7 governance): every mutation of published
// state is recorded against the acting token, and the log is owner-only —
// it names who did what, so a publisher/reader token must not enumerate it.
test.describe("zed-api-server audit log", () => {
  const org = `audit-${Date.now().toString(36)}`;
  let owner: string;

  type Entry = {
    at: string;
    action: string;
    action_kind?: string;
    subject: string;
    actor_token_name: string;
    actor_role: string;
    detail?: string;
  };

  const readLog = async (
    request: import("@playwright/test").APIRequestContext,
    token: string,
    params?: Record<string, string>,
  ) =>
    request.get(`${API_URL}/v1/orgs/${org}/audit`, {
      headers: { authorization: `Bearer ${token}` },
      params,
    });

  test.beforeAll(async () => {
    // create-token creates the org too, so the claim itself isn't audited here;
    // publish/yank below are the mutations under test.
    owner = await createToken(`${org}-owner`, org, "owner");
    await publishFixture(
      { org, name: "trail", version: "1.0.0", description: "audit fixture" },
      { token: owner, allowExisting: true },
    );
  });

  test("a publish is recorded with the actor, subject, and artifact digest", async ({ request }) => {
    const res = await readLog(request, owner);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { org: string; entries: Entry[] };
    expect(body.org).toBe(org);

    const publish = body.entries.find((e) => e.action === "publish");
    expect(publish, `no publish entry in ${JSON.stringify(body.entries)}`).toBeTruthy();
    expect(publish!.subject).toBe(`${org}/trail@1.0.0`);
    expect(publish!.actor_token_name).toBe(`${org}-owner`);
    expect(publish!.actor_role).toBe("owner");
    // The digest is carried as detail so the trail ties to exact bytes.
    expect(publish!.detail).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(publish!.action_kind).toBe("publish");
  });

  test("yank and restore are recorded as distinct actions, newest first", async ({ request }) => {
    const yank = (yanked: boolean) =>
      request.post(`${API_URL}/v1/packages/${org}/trail/versions/1.0.0/yank`, {
        headers: { authorization: `Bearer ${owner}` },
        data: { yanked },
      });
    expect((await yank(true)).status()).toBe(200);
    expect((await yank(false)).status()).toBe(200);

    const body = (await (await readLog(request, owner)).json()) as { entries: Entry[] };
    const actions = body.entries.map((e) => e.action);
    expect(actions).toContain("yank");
    expect(actions).toContain("unyank");
    // Newest first: the restore we just did precedes the yank before it.
    expect(actions.indexOf("unyank")).toBeLessThan(actions.indexOf("yank"));
    // Timestamps are non-increasing down the list.
    const times = body.entries.map((e) => Date.parse(e.at));
    for (let i = 1; i < times.length; i++) expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
  });

  test("the audit log is owner-only: publisher and reader tokens are refused", async ({ request }) => {
    for (const role of ["publisher", "reader"]) {
      const scoped = await createToken(`${org}-${role}`, org, role);
      const res = await readLog(request, scoped);
      expect(res.status(), `role ${role} must not read the audit log`).toBe(403);
      expect((await res.json()).code).toBe("insufficient_role");
    }
  });

  test("a token from another org cannot read this org's audit log", async ({ request }) => {
    const otherOrg = `${org}-other`;
    const foreign = await createToken(`${otherOrg}-owner`, otherOrg, "owner");
    const res = await readLog(request, foreign);
    expect(res.status()).toBe(401);
  });

  test("an unauthenticated read is refused", async ({ request }) => {
    const res = await request.get(`${API_URL}/v1/orgs/${org}/audit`);
    expect(res.status()).toBe(401);
  });

  test("limit caps the number of entries returned", async ({ request }) => {
    const one = (await (await readLog(request, owner, { limit: "1" })).json()) as {
      entries: Entry[];
    };
    expect(one.entries).toHaveLength(1);
  });

  test("claiming an org through the API records the claim", async ({ request }) => {
    // Use an unscoped admin token: it may both claim a fresh namespace and
    // read that namespace's log (a token scoped to another org is correctly
    // refused, which the cross-org test above already covers).
    const claimed = `${org}-claimed`;
    const admin = await createAdminToken(`${org}-admin`);
    const res = await request.post(`${API_URL}/v1/orgs`, {
      headers: { authorization: `Bearer ${admin}` },
      data: { slug: claimed },
    });
    expect(res.status(), await res.text()).toBe(200);

    const body = (await (
      await request.get(`${API_URL}/v1/orgs/${claimed}/audit`, {
        headers: { authorization: `Bearer ${admin}` },
      })
    ).json()) as { entries: Entry[] };
    const claim = body.entries.find((e) => e.action === "org_claim");
    expect(claim, `no org_claim entry in ${JSON.stringify(body.entries)}`).toBeTruthy();
    expect(claim!.subject).toBe(claimed);
    // An unscoped token has no org role of its own; it is recorded as `admin`.
    expect(claim!.actor_role).toBe("admin");
  });
});
