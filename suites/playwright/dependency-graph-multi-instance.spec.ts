import { expect, test } from "@playwright/test";

import { ensureDependencyGraphSeeded } from "../../harness/graph-fixtures.js";
import { WEB_URL } from "../../harness/stack.js";

interface GraphIdentitySnapshot {
  readonly outerId: string;
  readonly namespace: string | null;
  readonly ownedIds: readonly string[];
  readonly ariaReferencesResolveInsideOwner: boolean;
  readonly markerReferencesResolveInsideOwner: boolean;
  readonly markerIds: readonly string[];
}

interface PageIdentitySnapshot {
  readonly allIds: readonly string[];
  readonly duplicateIds: readonly string[];
  readonly graphs: readonly GraphIdentitySnapshot[];
}

async function identitySnapshot(page: Parameters<typeof test>[0]["page"]): Promise<PageIdentitySnapshot> {
  return page.evaluate(() => {
    const graphs = Array.from(
      document.querySelectorAll<HTMLElement>("zed-dependency-graph"),
    );
    const snapshots = graphs.map((graph) => {
      const svg = graph.querySelector<SVGSVGElement>('svg[data-role="svg"]');
      if (svg === null) throw new Error("graph instance omitted its SVG workspace");

      const ownedIds = Array.from(graph.querySelectorAll<HTMLElement>("[id]"))
        .map((element) => element.id)
        .filter(Boolean);
      const resolvesInsideOwner = (identifier: string): boolean => {
        const target = document.getElementById(identifier);
        return target !== null && graph.contains(target);
      };
      const ariaIds = [
        ...(svg.getAttribute("aria-labelledby") ?? "").split(/\s+/),
        ...(svg.getAttribute("aria-describedby") ?? "").split(/\s+/),
      ].filter(Boolean);
      const markerIds = Array.from(
        graph.querySelectorAll<SVGPathElement>('.dg-edge[marker-end]'),
      ).map((edge) => {
        const markerEnd = edge.getAttribute("marker-end") ?? "";
        const match = /^url\(#([^)]+)\)$/.exec(markerEnd);
        if (match === null) {
          throw new Error(`unexpected marker reference ${JSON.stringify(markerEnd)}`);
        }
        return match[1];
      });

      return {
        outerId: graph.id,
        namespace: graph.getAttribute("data-graph-namespace"),
        ownedIds,
        ariaReferencesResolveInsideOwner:
          ariaIds.length === 3 && ariaIds.every(resolvesInsideOwner),
        markerReferencesResolveInsideOwner:
          markerIds.length > 0 && markerIds.every(resolvesInsideOwner),
        markerIds: [...new Set(markerIds)],
      };
    });
    const allIds = snapshots.flatMap(({ outerId, ownedIds }) => [
      outerId,
      ...ownedIds,
    ]);
    const duplicateIds = allIds.filter(
      (identifier, index) => allIds.indexOf(identifier) !== index,
    );
    return {
      allIds,
      duplicateIds: [...new Set(duplicateIds)],
      graphs: snapshots,
    };
  });
}

test.describe("dependency graph reusable component certification", () => {
  test.skip(
    process.env.ZED_E2E_DEPENDENCY_GRAPH_CANDIDATE !== "1",
    "requires the dependency-graph candidate workflow's pinned sibling revisions",
  );

  test.beforeAll(async () => {
    await ensureDependencyGraphSeeded();
  });

  test("two live graph instances keep DOM, ARIA, SVG, export, and reconnect state isolated", async ({
    page,
  }) => {
    const fixture = await ensureDependencyGraphSeeded();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const response = await page.goto(
      `${WEB_URL}/p/${encodeURIComponent(fixture.app.org)}/${encodeURIComponent(fixture.app.name)}`,
    );
    expect(response?.status()).toBe(200);

    const graphs = page.locator("zed-dependency-graph");
    await expect(graphs).toHaveCount(1);
    await expect(
      graphs.first().getByRole("group", {
        name: /interactive package dependency graph/i,
      }),
    ).toBeVisible({ timeout: 20_000 });

    await page.evaluate(() => {
      const original = document.querySelector<HTMLElement>(
        "zed-dependency-graph",
      );
      if (original === null) throw new Error("package page omitted its graph");
      const clone = original.cloneNode(false) as HTMLElement;
      clone.removeAttribute("data-ready");
      clone.id = original.id;
      original.after(clone);
    });

    await expect(graphs).toHaveCount(2);
    for (let index = 0; index < 2; index += 1) {
      const graph = graphs.nth(index);
      await expect(graph).toHaveAttribute("data-ready", "true");
      await expect(graph).toHaveAttribute("data-graph-namespace", /^dg-[0-9a-z]+$/);
      await expect(
        graph.getByRole("group", {
          name: /interactive package dependency graph/i,
        }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(graph.locator(".dg-node").first()).toBeVisible();
      expect(await graph.locator(".dg-node").count()).toBeGreaterThan(1);
      expect(await graph.locator(".dg-edge").count()).toBeGreaterThan(0);
      await expect(graph.locator("a[data-export]")).toHaveCount(10);
      await expect(graph.locator("[data-projection-export]")).toHaveCount(2);

      await graph.locator(".dg-node").first().click();
      const selectedRect = graph.locator(".dg-node.is-selected rect").first();
      await expect(selectedRect).toBeVisible();
      const selectedFilter = await selectedRect.evaluate(
        (element) => getComputedStyle(element).filter,
      );
      expect(selectedFilter).not.toBe("none");
    }

    const initial = await identitySnapshot(page);
    expect(initial.graphs).toHaveLength(2);
    expect(initial.duplicateIds).toEqual([]);
    expect(new Set(initial.graphs.map(({ outerId }) => outerId)).size).toBe(2);
    expect(
      initial.graphs.filter(({ outerId }) => outerId === "dependency-graph"),
    ).toHaveLength(1);
    expect(
      new Set(initial.graphs.map(({ namespace }) => namespace)).size,
    ).toBe(2);
    for (const graph of initial.graphs) {
      expect(graph.namespace).toMatch(/^dg-[0-9a-z]+$/);
      expect(graph.ownedIds).toHaveLength(4);
      expect(
        graph.ownedIds.every((identifier) =>
          identifier.startsWith(`${graph.namespace}-`),
        ),
      ).toBe(true);
      expect(graph.ariaReferencesResolveInsideOwner).toBe(true);
      expect(graph.markerReferencesResolveInsideOwner).toBe(true);
      expect(graph.markerIds).toHaveLength(1);
      expect(graph.markerIds[0]).toBe(`${graph.namespace}-arrow`);
    }

    const secondBeforeReconnect = initial.graphs[1];
    await page.evaluate(async () => {
      const graphs = Array.from(
        document.querySelectorAll<HTMLElement>("zed-dependency-graph"),
      );
      const [first, second] = graphs;
      if (first === undefined || second === undefined) {
        throw new Error("expected two graph instances before reconnect");
      }
      second.remove();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      first.after(second);
    });

    await expect(graphs).toHaveCount(2);
    await expect(graphs.nth(1)).toHaveAttribute("data-ready", "true");
    await expect(
      graphs.nth(1).getByRole("group", {
        name: /interactive package dependency graph/i,
      }),
    ).toBeVisible({ timeout: 20_000 });

    const reconnected = await identitySnapshot(page);
    expect(reconnected.duplicateIds).toEqual([]);
    expect(reconnected.graphs[1].outerId).toBe(secondBeforeReconnect.outerId);
    expect(reconnected.graphs[1].namespace).toBe(secondBeforeReconnect.namespace);
    expect(reconnected.graphs[1].ariaReferencesResolveInsideOwner).toBe(true);
    expect(reconnected.graphs[1].markerReferencesResolveInsideOwner).toBe(true);
    expect(pageErrors).toEqual([]);
  });
});
