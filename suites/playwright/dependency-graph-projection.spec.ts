import { expect, test, type Download } from "@playwright/test";
import { readFileSync } from "node:fs";

import { ensureDependencyGraphSeeded } from "../../harness/graph-fixtures.js";
import { WEB_URL } from "../../harness/stack.js";

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9.+-]/g, "_");
}

function projectionFilename(
  org: string,
  name: string,
  version: string,
  format: "svg" | "png",
): string {
  return `${safeFilename(org)}_${safeFilename(name)}_${safeFilename(version)}.dependency-graph.visible.${format}`;
}

async function downloadBytes(download: Download): Promise<Buffer> {
  const filePath = await download.path();
  if (filePath === null) {
    throw new Error("Playwright did not materialize the projection download");
  }
  return readFileSync(filePath);
}

test.describe("dependency graph visible projection exports", () => {
  test.skip(
    process.env.ZED_E2E_DEPENDENCY_GRAPH_CANDIDATE !== "1",
    "requires the dependency-graph candidate workflow's pinned sibling revisions",
  );

  test.beforeAll(async () => {
    await ensureDependencyGraphSeeded();
  });

  test("downloads bounded self-contained SVG and PNG bytes from the live workspace", async ({
    page,
  }) => {
    const fixture = await ensureDependencyGraphSeeded();
    const response = await page.goto(
      `${WEB_URL}/p/${encodeURIComponent(fixture.app.org)}/${encodeURIComponent(fixture.app.name)}`,
    );
    expect(response?.status()).toBe(200);

    const workspace = page.locator("zed-dependency-graph");
    await expect(workspace.locator('svg[data-role="svg"]')).toBeVisible({
      timeout: 20_000,
    });
    await expect(workspace).toContainText(fixture.app.version);

    await workspace.locator("details.dg-export-menu > summary").click();

    const [svgDownload] = await Promise.all([
      page.waitForEvent("download"),
      workspace
        .getByRole("button", { name: "SVG visible projection", exact: true })
        .click(),
    ]);
    expect(svgDownload.suggestedFilename()).toBe(
      projectionFilename(
        fixture.app.org,
        fixture.app.name,
        fixture.app.version,
        "svg",
      ),
    );
    const svgBytes = await downloadBytes(svgDownload);
    const svgText = svgBytes.toString("utf8");
    expect(svgText).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svgText).toContain('role="img"');
    expect(svgText).toContain(`${fixture.app.org}/${fixture.app.name}`);
    expect(svgText).toContain("relationships.");
    expect(svgText).not.toMatch(/<script|<foreignObject|https?:\/\/(?!www\.w3\.org\/2000\/svg)/i);
    const svgDimensions = /<svg[^>]* width="(\d+)" height="(\d+)"/.exec(svgText);
    expect(svgDimensions).not.toBeNull();
    const svgWidth = Number(svgDimensions?.[1]);
    const svgHeight = Number(svgDimensions?.[2]);
    expect(svgWidth).toBeGreaterThan(0);
    expect(svgHeight).toBeGreaterThan(0);
    expect(svgWidth).toBeLessThanOrEqual(4096);
    expect(svgHeight).toBeLessThanOrEqual(4096);
    await expect(workspace.locator('[data-role="status"]')).toContainText(
      "Downloaded the visible graph projection as SVG.",
    );

    const [pngDownload] = await Promise.all([
      page.waitForEvent("download"),
      workspace
        .getByRole("button", { name: "PNG visible projection", exact: true })
        .click(),
    ]);
    expect(pngDownload.suggestedFilename()).toBe(
      projectionFilename(
        fixture.app.org,
        fixture.app.name,
        fixture.app.version,
        "png",
      ),
    );
    const pngBytes = await downloadBytes(pngDownload);
    expect(pngBytes.length).toBeGreaterThan(1_000);
    expect(pngBytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const pngWidth = pngBytes.readUInt32BE(16);
    const pngHeight = pngBytes.readUInt32BE(20);
    expect(pngWidth).toBeGreaterThan(0);
    expect(pngHeight).toBeGreaterThan(0);
    expect(pngWidth).toBeLessThanOrEqual(4096);
    expect(pngHeight).toBeLessThanOrEqual(4096);
    expect(pngBytes.subarray(-8, -4).toString("ascii")).toBe("IEND");
    await expect(workspace.locator('[data-role="status"]')).toContainText(
      "Downloaded the visible graph projection as PNG.",
    );
  });

  test("keeps a semantic download table when JavaScript is disabled", async ({
    browser,
  }) => {
    const fixture = await ensureDependencyGraphSeeded();
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      const response = await page.goto(
        `${WEB_URL}/p/${encodeURIComponent(fixture.app.org)}/${encodeURIComponent(fixture.app.name)}`,
      );
      expect(response?.status()).toBe(200);

      const table = page.locator("table.dg-fallback-table");
      await expect(table).toBeVisible();
      await expect(table.locator("caption")).toContainText(
        `${fixture.app.org}/${fixture.app.name}@${fixture.app.version}`,
      );
      await expect(table.locator("tbody tr")).toHaveCount(10);
      await expect(table.locator('a[href$="/export/json"]')).toHaveCount(1);
      const csv = table.locator('a[href$="/export/csv"]');
      await expect(csv).toHaveCount(1);
      await expect(csv).toHaveText("Open semantic relationship table");
      await expect(csv).toHaveAttribute("download", "");
    } finally {
      await context.close();
    }
  });
});
