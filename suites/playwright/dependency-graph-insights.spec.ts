import { expect, test } from "@playwright/test";

import { ensureDependencyGraphSeeded } from "../../harness/graph-fixtures.js";
import { WEB_URL } from "../../harness/stack.js";

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
});
