import { expect, test, type APIRequestContext } from "@playwright/test";

import { publishFixture } from "../../harness/fixtures.js";
import {
  API_URL,
  createAdminToken,
  createToken,
  setPackageVisibilityForTest,
} from "../../harness/stack.js";

interface PrivateFixture {
  readonly ownerToken: string;
  readonly otherOrgToken: string;
  readonly unscopedAdminToken: string;
  readonly org: string;
  readonly name: string;
  readonly version: string;
}

function graphUrl(fixture: Pick<PrivateFixture, "org" | "name" | "version">): string {
  return `${API_URL}/v1/packages/${encodeURIComponent(fixture.org)}/${encodeURIComponent(fixture.name)}/versions/${encodeURIComponent(fixture.version)}/dependency-graph?view=declared`;
}

async function concealedResponse(
  request: APIRequestContext,
  url: string,
  token?: string,
): Promise<{ status: number; body: string; contentType: string | undefined }> {
  const response = await request.get(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    failOnStatusCode: false,
  });
  return {
    status: response.status(),
    body: await response.text(),
    contentType: response.headers()["content-type"],
  };
}

test.describe("private dependency graph tenant isolation", () => {
  test.skip(
    process.env.ZED_E2E_DEPENDENCY_GRAPH_CANDIDATE !== "1",
    "requires the dependency-graph candidate workflow's isolated PostgreSQL stack",
  );

  let fixture: PrivateFixture;

  test.beforeAll(async ({}, workerInfo) => {
    const suffix = `${workerInfo.project.name}-${Date.now().toString(36)}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(-30);
    const org = `graph-private-${suffix}`.slice(0, 63).replace(/-+$/g, "");
    const otherOrg = `graph-other-${suffix}`.slice(0, 63).replace(/-+$/g, "");
    const name = "private-root";
    const version = "1.0.0";
    const ownerToken = await createToken(`${org}-owner`, org);
    const otherOrgToken = await createToken(`${otherOrg}-owner`, otherOrg);
    const unscopedAdminToken = await createAdminToken(`graph-admin-${suffix}`);
    await publishFixture(
      { org, name, version, description: "Private dependency graph isolation fixture" },
      { token: ownerToken },
    );
    await setPackageVisibilityForTest(org, name, "private");
    fixture = {
      ownerToken,
      otherOrgToken,
      unscopedAdminToken,
      org,
      name,
      version,
    };
  });

  test("matching org token reads private bytes with no-store validators", async ({ request }) => {
    const response = await request.get(graphUrl(fixture), {
      headers: { Authorization: `Bearer ${fixture.ownerToken}` },
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect(response.headers().vary.toLowerCase().split(/\s*,\s*/)).toEqual([
      "accept",
      "authorization",
    ]);
    expect(response.headers()["x-zpkg-graph-authoritative"]).toBe("true");
    expect(response.headers()["x-zpkg-graph-digest"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(response.headers().etag).toMatch(/^"[0-9a-f]{64}"$/);
    const document = await response.json();
    expect(document.package).toMatchObject({
      org: fixture.org,
      name: fixture.name,
      version: fixture.version,
    });

    const conditional = await request.get(graphUrl(fixture), {
      headers: {
        Authorization: `Bearer ${fixture.ownerToken}`,
        "If-None-Match": `W/${response.headers().etag}`,
      },
      failOnStatusCode: false,
    });
    expect(conditional.status()).toBe(304);
    expect((await conditional.body()).byteLength).toBe(0);
    expect(conditional.headers()["cache-control"]).toBe("private, no-store");
    expect(conditional.headers().vary.toLowerCase()).toContain("authorization");
  });

  test("anonymous, another org, and unscoped admin cannot distinguish the private coordinate", async ({ request }) => {
    const known = graphUrl(fixture);
    const missing = graphUrl({ ...fixture, name: "does-not-exist" });
    const attempts = await Promise.all([
      concealedResponse(request, known),
      concealedResponse(request, known, fixture.otherOrgToken),
      concealedResponse(request, known, fixture.unscopedAdminToken),
      concealedResponse(request, missing, fixture.otherOrgToken),
    ]);
    for (const attempt of attempts) {
      expect(attempt.status).toBe(404);
      expect(attempt.contentType).toContain("application/json");
      expect(JSON.parse(attempt.body)).toMatchObject({
        code: "not_found",
        message: "dependency graph not found",
      });
      expect(attempt.body).not.toContain(fixture.org);
      expect(attempt.body).not.toContain(fixture.name);
      expect(attempt.body).not.toContain(fixture.version);
    }
    expect(new Set(attempts.map(({ body }) => body)).size).toBe(1);
  });
});
