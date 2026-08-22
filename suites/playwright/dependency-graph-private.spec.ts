import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";

import { publishFixture } from "../../harness/fixtures.js";
import {
  API_URL,
  WEB_URL,
  type BrowserSessionFixture,
  createAdminToken,
  createBrowserOrgMemberForTest,
  createBrowserProjectMemberForTest,
  createToken,
  setPackageVisibilityForTest,
} from "../../harness/stack.js";

interface PrivateFixture {
  readonly ownerToken: string;
  readonly otherOrgToken: string;
  readonly unscopedAdminToken: string;
  readonly org: string;
  readonly otherOrg: string;
  readonly name: string;
  readonly publicName: string;
  readonly project: string;
  readonly version: string;
  readonly orgMember: BrowserSessionFixture;
  readonly otherOrgMember: BrowserSessionFixture;
  readonly projectMember: BrowserSessionFixture;
}

interface ScopeSnapshot {
  readonly status: number;
  readonly bodyText: string;
  readonly scopeKind: string | null;
  readonly sources: readonly {
    readonly org: string;
    readonly name: string;
    readonly version: string;
    readonly private: boolean;
  }[];
  readonly fallbackRows: readonly string[];
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

async function scopeSnapshot(
  browser: Browser,
  path: string,
  session?: BrowserSessionFixture,
): Promise<ScopeSnapshot> {
  // JavaScript is disabled intentionally: this certifies the server-authorized
  // Maud source set and accessible fallback without letting private BFF fetches
  // introduce a separate Shared Auth delegation dependency.
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    if (session) {
      await context.addCookies([{
        name: session.cookieName,
        value: session.cookieValue,
        url: WEB_URL,
        httpOnly: true,
        sameSite: "Lax",
      }]);
    }
    const page = await context.newPage();
    const response = await page.goto(`${WEB_URL}${path}`);
    const workspace = page.locator("zed-dependency-graph");
    const hasWorkspace = await workspace.count() > 0;
    const sourcesJson = hasWorkspace ? await workspace.getAttribute("data-sources") : null;
    return {
      status: response?.status() ?? 0,
      bodyText: await page.locator("body").innerText(),
      scopeKind: hasWorkspace ? await workspace.getAttribute("data-scope-kind") : null,
      sources: sourcesJson ? JSON.parse(sourcesJson) : [],
      fallbackRows: await page.locator(".dg-fallback-table tbody tr").allInnerTexts(),
    };
  } finally {
    await context.close();
  }
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
    const publicName = "public-root";
    const project = "direct-members";
    const version = "1.0.0";
    const ownerToken = await createToken(`${org}-owner`, org);
    const otherOrgToken = await createToken(`${otherOrg}-owner`, otherOrg);
    const unscopedAdminToken = await createAdminToken(`graph-admin-${suffix}`);
    await publishFixture(
      { org, name, version, description: "Private dependency graph isolation fixture" },
      { token: ownerToken },
    );
    await publishFixture(
      { org, name: publicName, version, description: "Public dependency graph aggregate fixture" },
      { token: ownerToken },
    );
    await setPackageVisibilityForTest(org, name, "private");
    const orgMember = await createBrowserOrgMemberForTest(org);
    const otherOrgMember = await createBrowserOrgMemberForTest(otherOrg);
    const projectMember = await createBrowserProjectMemberForTest(
      org,
      project,
      [name, publicName],
    );
    fixture = {
      ownerToken,
      otherOrgToken,
      unscopedAdminToken,
      org,
      otherOrg,
      name,
      publicName,
      project,
      version,
      orgMember,
      otherOrgMember,
      projectMember,
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

  test("real browser sessions enforce organization and direct-project aggregate membership", async ({ browser }) => {
    const orgPath = `/dashboard/${encodeURIComponent(fixture.org)}/dependency-graph`;
    const projectPath = `/orgs/${encodeURIComponent(fixture.org)}/projects/${encodeURIComponent(fixture.project)}/dependency-graph`;

    const orgView = await scopeSnapshot(browser, orgPath, fixture.orgMember);
    expect(orgView.status).toBe(200);
    expect(orgView.scopeKind).toBe("organization");
    expect(orgView.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        org: fixture.org,
        name: fixture.name,
        version: fixture.version,
        private: true,
      }),
      expect.objectContaining({
        org: fixture.org,
        name: fixture.publicName,
        version: fixture.version,
        private: false,
      }),
    ]));
    expect(orgView.fallbackRows.join("\n")).toContain(`${fixture.org}/${fixture.name}`);
    expect(orgView.fallbackRows.join("\n")).toContain(`${fixture.org}/${fixture.publicName}`);

    // Organization membership is also valid project authority.
    const orgMemberProjectView = await scopeSnapshot(browser, projectPath, fixture.orgMember);
    expect(orgMemberProjectView.status).toBe(200);
    expect(orgMemberProjectView.scopeKind).toBe("project");

    // Direct project membership grants only that project, not its organization.
    const projectView = await scopeSnapshot(browser, projectPath, fixture.projectMember);
    expect(projectView.status).toBe(200);
    expect(projectView.scopeKind).toBe("project");
    expect(projectView.sources.map(({ name, private: isPrivate }) => ({ name, private: isPrivate })))
      .toEqual(expect.arrayContaining([
        { name: fixture.name, private: true },
        { name: fixture.publicName, private: false },
      ]));
    expect((await scopeSnapshot(browser, orgPath, fixture.projectMember)).status).toBe(404);

    const denied = await Promise.all([
      scopeSnapshot(browser, orgPath),
      scopeSnapshot(browser, orgPath, fixture.otherOrgMember),
      scopeSnapshot(browser, projectPath),
      scopeSnapshot(browser, projectPath, fixture.otherOrgMember),
    ]);
    for (const attempt of denied) {
      expect(attempt.status).toBe(404);
      expect(attempt.sources).toEqual([]);
      expect(attempt.bodyText).not.toContain(fixture.name);
      expect(attempt.bodyText).not.toContain(fixture.publicName);
      expect(attempt.bodyText).not.toContain(fixture.project);
    }
  });
});
