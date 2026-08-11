import { expect, test, type APIRequestContext } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureDependencyGraphSeeded } from "../../harness/graph-fixtures.js";
import { WEB_URL, runZed } from "../../harness/stack.js";

const GRAPH_DIGEST_HEADER = "x-zpkg-graph-digest";
const GRAPH_AUTHORITY_HEADER = "x-zpkg-graph-authoritative";

function packageGraphPath(org: string, name: string, version: string): string {
  return `${WEB_URL}/bff/dependency-graphs/packages/${encodeURIComponent(org)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

function exportPath(
  org: string,
  name: string,
  version: string,
  format: string,
): string {
  return `${packageGraphPath(org, name, version)}/export/${format}`;
}

async function expectImmutableValidator(
  request: APIRequestContext,
  url: string,
): Promise<{ etag: string; digest: string }> {
  const response = await request.get(url, { failOnStatusCode: false });
  expect(response.status()).toBe(200);
  const headers = response.headers();
  const etag = headers.etag;
  const digest = headers[GRAPH_DIGEST_HEADER];
  if (etag === undefined || digest === undefined) {
    throw new Error("graph response omitted its ETag or semantic digest");
  }
  expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
  expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);

  const conditional = await request.get(url, {
    headers: { "If-None-Match": etag },
    failOnStatusCode: false,
  });
  expect(conditional.status()).toBe(304);
  expect(conditional.headers().etag).toBe(etag);
  expect(conditional.headers()[GRAPH_DIGEST_HEADER]).toBe(digest);
  expect((await conditional.body()).byteLength).toBe(0);
  return { etag, digest };
}

test.describe("dependency graph candidate stack", () => {
  test.beforeAll(async () => {
    await ensureDependencyGraphSeeded();
  });

  test("same-origin BFF exposes one immutable semantic graph", async ({
    request,
  }) => {
    const fixture = await ensureDependencyGraphSeeded();
    const url = packageGraphPath(
      fixture.app.org,
      fixture.app.name,
      fixture.app.version,
    );
    const { digest } = await expectImmutableValidator(request, url);
    const response = await request.get(url);
    const document = await response.json();
    const serialized = JSON.stringify(document);

    expect(document.schema).toBe("zpkg/dependency-graph/v1");
    expect(document.graph_digest).toBe(digest);
    expect(serialized).toContain("graph-core");
    expect(serialized).toContain("graph-util");
    expect(response.headers()["content-type"]).toContain("dependency-graph");
  });

  test("all text, analytics, and binary representations share a digest", async ({
    request,
  }) => {
    const fixture = await ensureDependencyGraphSeeded();
    const formats = [
      "json",
      "yaml",
      "toml",
      "dot",
      "mermaid",
      "json5",
      "xml",
      "csv",
      "msgpack",
      "protobuf",
    ] as const;
    const extended = new Set(["json5", "xml", "csv", "msgpack", "protobuf"]);
    const authoritative = new Set(["json5", "xml", "msgpack", "protobuf"]);
    const digests = new Set<string>();
    const etags = new Set<string>();

    for (const format of formats) {
      const response = await request.get(
        exportPath(
          fixture.app.org,
          fixture.app.name,
          fixture.app.version,
          format,
        ),
        { failOnStatusCode: false },
      );
      expect(response.status(), format).toBe(200);
      const headers = response.headers();
      const body = await response.body();
      const digest = headers[GRAPH_DIGEST_HEADER];
      const etag = headers.etag;
      if (digest === undefined || etag === undefined) {
        throw new Error(`${format} response omitted its validators`);
      }
      expect(body.byteLength, format).toBeGreaterThan(8);
      expect(headers["content-type"], format).toBeTruthy();
      expect(digest, format).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(etag, format).toMatch(/^"[0-9a-f]{64}"$/);
      digests.add(digest);
      etags.add(etag);

      if (extended.has(format)) {
        expect(headers["content-disposition"], format).toContain(
          ".dependency-graph.",
        );
        expect(headers[GRAPH_AUTHORITY_HEADER], format).toBe(
          authoritative.has(format) ? "true" : "false",
        );
      }
    }

    expect(digests.size).toBe(1);
    expect(etags.size).toBe(formats.length);
  });

  test("CLI downloads binary graphs atomically and reports validators", async () => {
    const fixture = await ensureDependencyGraphSeeded();
    const directory = mkdtempSync(path.join(os.tmpdir(), "zed-graph-e2e-"));
    const output = path.join(directory, "graph.pb");
    try {
      const downloaded = await runZed(
        [
          "graph",
          "package",
          fixture.coordinate,
          "--format",
          "protobuf",
          "--output",
          output,
          "--metadata-json",
        ],
        { env: { ZED_PKG_TOKEN: fixture.token } },
      );
      expect(downloaded.code, downloaded.stderr).toBe(0);
      expect(statSync(output).size).toBeGreaterThan(8);
      const metadataLine = downloaded.stderr
        .trim()
        .split("\n")
        .filter(Boolean)
        .at(-1);
      expect(metadataLine).toBeTruthy();
      const metadata = JSON.parse(metadataLine!);
      expect(metadata.schema).toBe("zed.graph-package-download/v1");
      expect(metadata.package).toBe(fixture.coordinate);
      expect(metadata.format).toBe("protobuf");
      expect(metadata.authoritative).toBe(true);
      expect(metadata.graph_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(metadata.etag).toMatch(/^"[0-9a-f]{64}"$/);
      expect(metadata.output).toBe(output);

      const original = readFileSync(output);
      const repeated = await runZed(
        [
          "graph",
          "package",
          fixture.coordinate,
          "--format",
          "protobuf",
          "--output",
          output,
        ],
        { env: { ZED_PKG_TOKEN: fixture.token } },
      );
      expect(repeated.code).not.toBe(0);
      expect(repeated.stderr).toContain("already exists");
      expect(readFileSync(output)).toEqual(original);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("package page renders the self-hosted interactive workspace", async ({
    page,
  }) => {
    const fixture = await ensureDependencyGraphSeeded();
    const externalRequests: string[] = [];
    const pageErrors: string[] = [];
    const webOrigin = new URL(WEB_URL).origin;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.protocol.startsWith("http") && url.origin !== webOrigin) {
        externalRequests.push(request.url());
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const response = await page.goto(
      `${WEB_URL}/p/${fixture.app.org}/${fixture.app.name}`,
    );
    expect(response?.status()).toBe(200);

    const workspace = page.locator("zed-dependency-graph");
    await expect(workspace).toHaveCount(1);
    await expect(workspace.locator("svg")).toBeVisible({ timeout: 20_000 });
    await expect(workspace).toContainText(fixture.app.version);
    await expect(workspace).toContainText("graph-core");
    await expect(workspace).toContainText("graph-util");

    await page.evaluate(() => {
      location.hash = "dependency-graph=graph-e2e%2Fgraph-core";
    });
    await expect(workspace.locator(".dg-inspector h3")).toHaveText(
      "graph-e2e/graph-core",
    );

    const controlsText = await workspace.innerText();
    expect(controlsText).toMatch(/direct dependencies/i);
    expect(controlsText).toMatch(/transitive dependencies/i);
    expect(controlsText).toMatch(/reverse/i);
    expect(controlsText).toMatch(/cycle/i);
    expect(controlsText).toMatch(/shortest path/i);
    expect(controlsText).toMatch(/layered/i);
    expect(controlsText).toMatch(/radial/i);
    expect(controlsText).toMatch(/force/i);

    const transitive = workspace.getByRole("button", {
      name: /transitive dependencies/i,
    });
    await expect(transitive).toBeVisible();
    await transitive.focus();
    await page.keyboard.press("Enter");
    await expect(workspace.locator("svg")).toBeVisible();

    for (const format of ["json5", "xml", "csv", "msgpack", "protobuf"]) {
      await expect(
        workspace.locator(`a[href$="/export/${format}"]`),
      ).toHaveCount(1);
    }
    expect(pageErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
  });
});
