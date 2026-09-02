import { expect, test } from "@playwright/test";

import { ensureDependencyGraphSeeded } from "../../harness/graph-fixtures.js";
import { WEB_URL } from "../../harness/stack.js";

const FILTER_KINDS = ["runtime", "build", "development", "peer", "tooling"];
const FILTER_CASES: ReadonlyArray<{
  name: string;
  kinds: readonly string[];
  includeOptional: boolean;
  explicit: boolean;
}> = [
  { name: "defaults", kinds: FILTER_KINDS, includeOptional: true, explicit: false },
  { name: "sparse", kinds: ["build", "tooling"], includeOptional: false, explicit: true },
  { name: "empty", kinds: [], includeOptional: false, explicit: true },
];

test.describe("dependency graph visual intelligence", () => {
  test.skip(
    process.env.ZED_E2E_DEPENDENCY_GRAPH_CANDIDATE !== "1",
    "requires the dependency-graph candidate workflow's pinned sibling revisions",
  );

  test.beforeAll(async () => {
    await ensureDependencyGraphSeeded();
  });

  test("self-hosted recommendation card and overview navigator remain interactive", async ({
    page,
  }) => {
    const fixture = await ensureDependencyGraphSeeded();
    const pageErrors: string[] = [];
    const externalRequests: string[] = [];
    const webOrigin = new URL(WEB_URL).origin;

    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.protocol.startsWith("http") && url.origin !== webOrigin) {
        externalRequests.push(request.url());
      }
    });

    const response = await page.goto(
      `${WEB_URL}/p/${encodeURIComponent(fixture.app.org)}/${encodeURIComponent(fixture.app.name)}`,
    );
    expect(response?.status()).toBe(200);

    const workspace = page.locator("zed-dependency-graph");
    const graph = workspace.getByRole("group", {
      name: /interactive package dependency graph/i,
    });
    await expect(graph).toBeVisible({ timeout: 20_000 });
    await expect(workspace.locator(".dg-node").first()).toBeVisible();

    const visualSearch = workspace.locator('[data-role="visual-search"]');
    const recommendation = visualSearch.locator(
      '[data-role="recommended-layout"]',
    );
    await expect(visualSearch).toBeVisible();
    await expect(recommendation).toHaveText(/^(Layered|Radial|Force)$/);
    await expect(visualSearch.locator('[data-score-layout]')).toHaveCount(3);
    for (const score of await visualSearch.locator('[data-score-layout] em').all()) {
      await expect(score).toHaveText(/^\d{1,3}$/);
    }

    const minimap = workspace.locator('[data-role="minimap"]');
    const minimapSvg = minimap.locator('svg[data-role="minimap-svg"]');
    await expect(minimap).toBeVisible();
    await expect(minimapSvg).toBeVisible();
    await expect(minimap.locator(".dg-minimap-node").first()).toBeVisible();
    await expect(minimap.locator(".dg-minimap-viewport")).toBeVisible();

    const before = await workspace.evaluate((element) =>
      JSON.stringify(
        (element as HTMLElement & { transform?: unknown }).transform ?? null,
      ),
    );
    await minimapSvg.click({ position: { x: 14, y: 14 } });
    await expect
      .poll(() =>
        workspace.evaluate((element) =>
          JSON.stringify(
            (element as HTMLElement & { transform?: unknown }).transform ?? null,
          ),
        ),
      )
      .not.toBe(before);

    const recommendationLabel = (await recommendation.textContent())?.trim();
    expect(["Layered", "Radial", "Force"]).toContain(recommendationLabel);
    const applyRecommendation = visualSearch.locator(
      '[data-action="apply-recommended-layout"]',
    );
    await expect(applyRecommendation).toBeVisible();
    if (await applyRecommendation.isEnabled()) {
      await applyRecommendation.click();
    }
    await expect(
      workspace.getByRole("button", {
        name: recommendationLabel!,
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(applyRecommendation).toBeDisabled();

    await minimap.getByRole("button", { name: "Fit dependency graph" }).click();
    await expect(graph).toBeVisible();
    expect(pageErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
  });

  for (const filterCase of FILTER_CASES) {
    test(`real package ${filterCase.name} filters survive initial load, reload, and edits`, async ({
      page,
    }) => {
      const fixture = await ensureDependencyGraphSeeded();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const url = new URL(
        `${WEB_URL}/p/${encodeURIComponent(fixture.app.org)}/${encodeURIComponent(fixture.app.name)}`,
      );
      if (filterCase.explicit) {
        // An explicitly empty kind set is not the same as absent defaults.
        url.searchParams.set("graph-kinds", filterCase.kinds.join(","));
        url.searchParams.set("graph-optional", filterCase.includeOptional ? "1" : "0");
      }
      const response = await page.goto(url.href);
      expect(response?.status()).toBe(200);
      const workspace = page.locator("zed-dependency-graph");
      const graph = workspace.getByRole("group", {
        name: /interactive package dependency graph/i,
      });

      const assertFilterState = async (expectedKinds: readonly string[]) => {
        await expect(graph).toBeVisible({ timeout: 20_000 });
        // Wait for actual graph data, not just the shell or an arbitrary delay.
        await expect
          .poll(async () => Number(await workspace.locator('[data-metric="nodes"]').textContent()))
          .toBeGreaterThan(0);
        for (const kind of FILTER_KINDS) {
          const control = workspace.locator(`[data-kind="${kind}"]`);
          if (expectedKinds.includes(kind)) await expect(control).toBeChecked();
          else await expect(control).not.toBeChecked();
        }
        const optional = workspace.getByLabel("Optional edges", { exact: true });
        if (filterCase.includeOptional) await expect(optional).toBeChecked();
        else await expect(optional).not.toBeChecked();
        await expect
          .poll(() => workspace.evaluate((element) => {
            const component = element as HTMLElement & {
              enabledKinds: Set<string>;
              includeOptional: boolean;
            };
            return {
              kinds: [...component.enabledKinds].sort(),
              includeOptional: component.includeOptional,
            };
          }))
          .toEqual({
            kinds: [...expectedKinds].sort(),
            includeOptional: filterCase.includeOptional,
          });
      };

      await assertFilterState(filterCase.kinds);
      expect((await page.reload())?.status()).toBe(200);
      await assertFilterState(filterCase.kinds);

      await workspace.getByText("Edge filters", { exact: true }).click();
      const nextKinds = new Set(filterCase.kinds);
      const enablePeer = !nextKinds.has("peer");
      if (enablePeer) nextKinds.add("peer");
      else nextKinds.delete("peer");
      await workspace.locator('[data-kind="peer"]').setChecked(enablePeer);
      await assertFilterState([...nextKinds]);
      await expect.poll(() => {
        const current = new URL(page.url());
        const serializedKinds = current.searchParams.get("graph-kinds");
        return {
          kinds: (serializedKinds === null ? FILTER_KINDS : serializedKinds.split(",").filter(Boolean)).slice().sort(),
          includeOptional: current.searchParams.get("graph-optional") !== "0",
        };
      }).toEqual({
        kinds: [...nextKinds].sort(),
        includeOptional: filterCase.includeOptional,
      });
      expect((await page.reload())?.status()).toBe(200);
      await assertFilterState([...nextKinds]);
      expect(pageErrors).toEqual([]);
    });
  }
});
