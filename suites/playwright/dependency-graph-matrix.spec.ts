import { expect, test, type Page, type Route } from "@playwright/test";
import { createHash } from "node:crypto";

import { WEB_URL } from "../../harness/stack.js";

const GRAPH_DIGEST = `sha256:${"a".repeat(64)}`;
const MATRIX_PAGE = `${WEB_URL}/__e2e/dependency-graph-matrix`;
const ROOT = {
  registry_id: "registry:e2e",
  org: "matrix",
  name: "root",
  version: "2.0.0-beta.1",
};

interface Identity {
  readonly registry_id: string;
  readonly org: string;
  readonly name: string;
  readonly version: string;
}

interface ResolvedFixture {
  readonly nodes: readonly Identity[];
  readonly roots: readonly Identity[];
  readonly edges: readonly {
    readonly from: Identity;
    readonly to: Identity;
    readonly kind: "runtime";
    readonly requirement?: string;
    readonly optional?: boolean;
  }[];
}

function identity(name: string, version = "1.0.0", org = "matrix"): Identity {
  return { registry_id: "registry:e2e", org, name, version };
}

function resolvedFixture(
  nodes: readonly Identity[],
  edges: readonly [number, number][],
  rootIndexes: readonly number[] = [0],
): ResolvedFixture {
  return {
    nodes,
    roots: rootIndexes.map((index) => nodes[index]!),
    edges: edges.map(([from, to]) => ({
      from: nodes[from]!,
      to: nodes[to]!,
      kind: "runtime",
      requirement: "*",
      optional: false,
    })),
  };
}

function declaredDocument() {
  return {
    schema: "zpkg/dependency-graph/v1",
    view: "declared",
    graph_digest: GRAPH_DIGEST,
    package: ROOT,
    dependencies: [
      {
        registry_id: "registry:e2e",
        org: "matrix",
        name: "stable-dependency",
        requirement: "^1.0.0",
        kind: "runtime",
        optional: false,
        features: [],
      },
      {
        registry_id: "registry:e2e",
        org: "vendor",
        name: "optional-dependency",
        requirement: "^3.0.0-beta.1",
        kind: "runtime",
        optional: true,
        features: [],
      },
    ],
  };
}

function matrixHtml(mode: "package" | "scope" = "package"): string {
  const attributes =
    mode === "package"
      ? `data-mode="package" data-org="matrix" data-package="root" data-version="${ROOT.version}" data-private="false" data-versions='[{"version":"${ROOT.version}","prerelease":true,"yanked":false}]'`
      : `data-mode="scope" data-scope-kind="organization" data-scope-title="Empty fixture" data-scope-description="Empty dependency graph fixture" data-sources="[]"`;
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Dependency graph matrix</title>
        <style>:root { color-scheme: dark; --text:#f2f2f0; --muted:#8fa1b5; --panel:#0d1118; --border:#263241; --orange:#ff7a1a; --blue:#8fd3f4; --mono:ui-monospace,monospace; } body { margin:24px; background:#07080c; color:var(--text); font-family:system-ui,sans-serif; } a { color:var(--blue); }</style>
        <link rel="stylesheet" href="/graph-assets/dependency-graph.css">
        <script type="module" src="/graph-assets/dependency-graph.js"></script>
      </head>
      <body>
        <main>
          <h1>Dependency graph matrix</h1>
          <zed-dependency-graph id="dependency-graph" ${attributes}>
            <noscript><p>JavaScript is required for the interactive fixture.</p></noscript>
          </zed-dependency-graph>
        </main>
      </body>
    </html>`;
}

async function fulfillDeclaredGraph(route: Route): Promise<void> {
  const body = JSON.stringify(declaredDocument());
  const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
  await route.fulfill({
    status: 200,
    headers: {
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": String(Buffer.byteLength(body)),
      "content-type": "application/vnd.zpkg.dependency-graph.v1+json",
      etag,
      "x-zpkg-graph-authoritative": "true",
      "x-zpkg-graph-digest": GRAPH_DIGEST,
    },
    body,
  });
}

async function openMatrixPage(
  page: Page,
  mode: "package" | "scope" = "package",
): Promise<void> {
  await page.route(MATRIX_PAGE, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: matrixHtml(mode) }),
  );
  await page.route("**/bff/dependency-graphs/packages/**", fulfillDeclaredGraph);
  const response = await page.goto(MATRIX_PAGE);
  expect(response?.status()).toBe(200);
  const workspace = page.locator("zed-dependency-graph");
  await expect(workspace).toHaveAttribute("data-ready", "true");
  if (mode === "package") {
    await expect(workspace.locator(".dg-node").first()).toBeVisible({ timeout: 15_000 });
  }
}

async function installResolvedFixture(
  page: Page,
  fixture: ResolvedFixture,
): Promise<number> {
  return page.locator("zed-dependency-graph").evaluate((element, graphFixture) => {
    const graph = element as HTMLElement & {
      clearGraph(): void;
      addDocument(document: unknown, options: { primary: boolean }): void;
      afterGraphLoaded(message: string): void;
    };
    const started = performance.now();
    graph.clearGraph();
    graph.addDocument(
      {
        schema: "zpkg/dependency-graph/v1",
        view: "resolved",
        nodes: graphFixture.nodes.map((id) => ({ id, features: [] })),
        roots: graphFixture.roots,
        edges: graphFixture.edges,
      },
      { primary: true },
    );
    graph.afterGraphLoaded("Installed deterministic matrix fixture.");
    return performance.now() - started;
  }, fixture);
}

const cycleNodes = [identity("cycle-a"), identity("cycle-b"), identity("cycle-c"), identity("tail")];
const deepNodes = Array.from({ length: 220 }, (_, index) => identity(`deep-${index.toString().padStart(3, "0")}`));
const wideNodes = [identity("wide-root"), ...Array.from({ length: 500 }, (_, index) => identity(`wide-${index.toString().padStart(3, "0")}`))];
const largeNodes = [identity("large-root"), ...Array.from({ length: 899 }, (_, index) => identity(`large-${index.toString().padStart(3, "0")}`))];

const matrixCases = [
  {
    name: "one-node",
    fixture: resolvedFixture([identity("only")], []),
    nodes: 1,
    edges: 0,
  },
  {
    name: "duplicate-edges",
    fixture: resolvedFixture([identity("duplicate-root"), identity("duplicate-leaf")], [[0, 1], [0, 1]]),
    nodes: 2,
    edges: 1,
  },
  {
    name: "cyclic",
    fixture: resolvedFixture(cycleNodes, [[0, 1], [1, 2], [2, 0], [2, 3]]),
    nodes: 4,
    edges: 4,
    query: "Cycles",
    result: 3,
  },
  {
    name: "disconnected",
    fixture: resolvedFixture(
      [identity("left-root"), identity("left-leaf"), identity("right-root"), identity("right-leaf")],
      [[0, 1], [2, 3]],
      [0, 2],
    ),
    nodes: 4,
    edges: 2,
  },
  {
    name: "deep",
    fixture: resolvedFixture(deepNodes, deepNodes.slice(1).map((_, index) => [index, index + 1])),
    nodes: deepNodes.length,
    edges: deepNodes.length - 1,
    query: "Longest chain",
    result: deepNodes.length,
  },
  {
    name: "wide",
    fixture: resolvedFixture(wideNodes, wideNodes.slice(1).map((_, index) => [0, index + 1])),
    nodes: wideNodes.length,
    edges: wideNodes.length - 1,
  },
  {
    name: "multi-version",
    fixture: resolvedFixture(
      [identity("consumer"), identity("shared", "1.0.0", "vendor"), identity("shared", "2.0.0", "vendor")],
      [[0, 1], [0, 2]],
    ),
    nodes: 3,
    edges: 2,
    query: "Multiple versions",
    result: 2,
  },
] as const;

test.describe("dependency graph fixture, accessibility, and performance matrix", () => {
  test.skip(
    process.env.ZED_E2E_DEPENDENCY_GRAPH_CANDIDATE !== "1",
    "requires the dependency-graph candidate workflow's pinned web revision",
  );

  test("empty scope has an explicit accessible state", async ({ page }) => {
    await openMatrixPage(page, "scope");
    const workspace = page.locator("zed-dependency-graph");
    await expect(workspace.locator('[data-role="status"]')).toHaveText(
      "No published package versions are available in this scope.",
    );
    await expect(workspace.locator('[data-metric="nodes"]')).toHaveText("0");
    await expect(workspace.locator('[data-metric="edges"]')).toHaveText("0");
    await expect(workspace.locator('[data-role="empty"]')).toBeVisible();
  });

  for (const matrixCase of matrixCases) {
    test(`${matrixCase.name} fixture remains deterministic and queryable`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await openMatrixPage(page);
      const elapsed = await installResolvedFixture(page, matrixCase.fixture);
      const workspace = page.locator("zed-dependency-graph");
      await expect(workspace.locator('[data-metric="nodes"]')).toHaveText(String(matrixCase.nodes));
      await expect(workspace.locator('[data-metric="edges"]')).toHaveText(String(matrixCase.edges));
      expect(elapsed, `${matrixCase.name} fixture render time`).toBeLessThan(5_000);
      expect(Number(await workspace.getAttribute("data-graph-render-ms"))).toBeLessThan(5_000);
      if ("query" in matrixCase) {
        await workspace.getByRole("button", { name: matrixCase.query, exact: true }).click();
        await expect(workspace.locator('[data-role="query-summary"]')).toBeVisible();
        await expect(workspace.locator('[data-role="query-summary"]')).toContainText(
          `of ${matrixCase.result} packages`,
        );
      }
      expect(pageErrors).toEqual([]);
    });
  }

  test("large graph uses a measured bounded canvas while retaining full query data", async ({ page }) => {
    await openMatrixPage(page);
    const fixture = resolvedFixture(
      largeNodes,
      largeNodes.slice(1).map((_, index) => [0, index + 1]),
    );
    const elapsed = await installResolvedFixture(page, fixture);
    const workspace = page.locator("zed-dependency-graph");
    await expect(workspace.locator('[data-metric="nodes"]')).toHaveText("900");
    await expect(workspace.locator('[data-role="degradation"]')).toBeVisible();
    await expect(workspace.locator('[data-role="degradation"]')).toContainText(
      "the canvas shows 750 of 900 packages",
    );
    await expect(workspace.locator(".dg-node")).toHaveCount(750);
    expect(elapsed).toBeLessThan(7_500);
    expect(Number(await workspace.getAttribute("data-graph-render-ms"))).toBeLessThan(5_000);
    await workspace.getByRole("button", { name: "High centrality", exact: true }).click();
    await expect(workspace.locator('[data-role="query-summary"]')).toContainText("of 20 packages");
  });

  test("URL, saved view, keyboard, reduced motion, zoom, and responsive state remain accessible", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openMatrixPage(page);
    const workspace = page.locator("zed-dependency-graph");
    await workspace.getByRole("button", { name: "Radial", exact: true }).click();
    await workspace.getByRole("searchbox", { name: "Find package" }).fill("optional");
    await workspace.locator('.dg-node[aria-label*="optional-dependency"]').click();
    await workspace.getByRole("button", { name: "Reverse impact", exact: true }).click();
    await workspace.getByLabel("Optional edges").uncheck();
    await workspace.getByRole("button", { name: "Save view", exact: true }).click();

    const stateUrl = new URL(page.url());
    expect(stateUrl.searchParams.get("graph-layout")).toBe("radial");
    expect(stateUrl.searchParams.get("graph-search")).toBe("optional");
    expect(stateUrl.searchParams.get("graph-optional")).toBe("0");
    expect(stateUrl.searchParams.get("graph-query")).toBe("dependents");
    expect(stateUrl.searchParams.get("graph-query-node")).toBeTruthy();
    expect(stateUrl.searchParams.get("graph-node")).toBeTruthy();
    expect(stateUrl.searchParams.get("graph-version")).toBe(ROOT.version);

    await workspace.getByRole("button", { name: "Reset", exact: true }).click();
    await workspace.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(workspace.getByRole("button", { name: "Radial", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(workspace.getByRole("searchbox", { name: "Find package" })).toHaveValue("optional");
    await expect(workspace.getByLabel("Optional edges")).not.toBeChecked();
    await expect(workspace.locator('[data-role="query-summary"]')).toBeVisible();

    await page.reload();
    await expect(workspace.locator(".dg-node").first()).toBeVisible({ timeout: 15_000 });
    await expect(workspace.getByRole("button", { name: "Radial", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(workspace.getByRole("searchbox", { name: "Find package" })).toHaveValue("optional");
    await expect(workspace.getByLabel("Optional edges")).not.toBeChecked();
    await expect(workspace.locator('[data-role="query-summary"] h3')).toContainText("Reverse impact");

    const ids = await page.locator("[id]").evaluateAll((elements) => elements.map((element) => element.id));
    expect(new Set(ids).size).toBe(ids.length);
    const svgReferencesResolve = await workspace.locator('svg[data-role="svg"]').evaluate((svg) =>
      [...(svg.getAttribute("aria-labelledby") ?? "").split(/\s+/), ...(svg.getAttribute("aria-describedby") ?? "").split(/\s+/)]
        .filter(Boolean)
        .every((id) => document.getElementById(id) !== null),
    );
    expect(svgReferencesResolve).toBe(true);

    const firstNode = workspace.locator(".dg-node").first();
    await firstNode.focus();
    await page.keyboard.press("ArrowRight");
    await expect(workspace.locator(".dg-node:focus")).toHaveCount(1);
    const transitionDuration = await workspace.locator(".dg-node").first().evaluate(
      (node) => getComputedStyle(node).transitionDuration,
    );
    expect(transitionDuration).toBe("0s");

    await page.setViewportSize({ width: 360, height: 760 });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await expect(workspace.getByRole("button", { name: "Copy link", exact: true })).toBeVisible();
    await expect(workspace.locator('[data-role="query-summary"]')).toBeVisible();
    const stageColumns = await workspace.locator(".dg-stage").evaluate(
      (stage) => getComputedStyle(stage).gridTemplateColumns.split(" ").length,
    );
    expect(stageColumns).toBe(1);
  });
});
