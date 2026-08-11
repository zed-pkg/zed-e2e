import { expect, test, type APIRequestContext } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ensureDependencyGraphSeeded } from "../../harness/graph-fixtures.js";
import { API_URL, WEB_URL, runZed } from "../../harness/stack.js";

const GRAPH_DIGEST_HEADER = "x-zpkg-graph-digest";
const GRAPH_AUTHORITY_HEADER = "x-zpkg-graph-authoritative";
const SELECTED_VERSION_HEADER = "x-zpkg-selected-version";
const PUBLIC_IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const PUBLIC_LATEST_CACHE = "public, max-age=60, must-revalidate";

const GRAPH_FORMATS = [
  {
    format: "json",
    mediaType: "application/vnd.zpkg.dependency-graph.v1+json",
    authoritative: true,
  },
  {
    format: "yaml",
    mediaType: "application/vnd.zpkg.dependency-graph.v1+yaml",
    authoritative: true,
  },
  {
    format: "toml",
    mediaType: "application/vnd.zpkg.dependency-graph.v1+toml",
    authoritative: true,
  },
  {
    format: "dot",
    mediaType: "text/vnd.graphviz; charset=utf-8",
    authoritative: false,
  },
  {
    format: "mermaid",
    mediaType: "text/vnd.mermaid; charset=utf-8",
    authoritative: false,
  },
  {
    format: "json5",
    mediaType: "application/vnd.zpkg.dependency-graph.v1+json5",
    authoritative: true,
  },
  {
    format: "xml",
    mediaType: "application/vnd.zpkg.dependency-graph.v1+xml",
    authoritative: true,
  },
  {
    format: "csv",
    mediaType: "text/csv; charset=utf-8",
    authoritative: false,
  },
  {
    format: "msgpack",
    mediaType: "application/vnd.zpkg.dependency-graph.v1+msgpack",
    authoritative: true,
  },
  {
    format: "protobuf",
    mediaType: "application/vnd.zpkg.dependency-graph.v1+protobuf",
    authoritative: true,
  },
] as const;

const REPRESENTATION_HEADERS = [
  "etag",
  GRAPH_DIGEST_HEADER,
  GRAPH_AUTHORITY_HEADER,
  "cache-control",
  "content-disposition",
  "content-length",
  "vary",
] as const;

interface ExpectedRepresentation {
  readonly mediaType: string;
  readonly authoritative: boolean;
  readonly cacheControl: string;
  readonly selectedVersion?: string;
}

interface TypeScriptGraphDownload {
  readonly status: 200 | 304;
  readonly notModified: boolean;
  readonly body: Uint8Array;
  readonly mediaType: string | null;
  readonly etag: string;
  readonly graphDigest: string;
  readonly authoritative: boolean;
  readonly filename: string;
}

type DownloadDependencyGraph = (options: {
  readonly baseUrl: string;
  readonly org: string;
  readonly name: string;
  readonly version: string;
  readonly format: string;
  readonly token: string;
  readonly allowInsecureTransport: boolean;
  readonly ifNoneMatch?: string;
  readonly timeoutMs: number;
}) => Promise<TypeScriptGraphDownload>;

function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function expectMatchingRepresentationHeaders(
  actual: Record<string, string>,
  expected: Record<string, string>,
  label: string,
  selectedVersion?: string,
  includeContentType = false,
): void {
  for (const name of REPRESENTATION_HEADERS) {
    expect(actual[name], `${label} ${name}`).toBe(expected[name]);
  }
  if (includeContentType) {
    expect(actual["content-type"], `${label} content-type`).toBe(
      expected["content-type"],
    );
  }
  if (selectedVersion !== undefined) {
    expect(actual[SELECTED_VERSION_HEADER], `${label} selected version`).toBe(
      selectedVersion,
    );
  }
}

async function loadTypeScriptGraphClient(): Promise<DownloadDependencyGraph> {
  const modulePath = process.env.ZED_E2E_TYPESCRIPT_CLIENT_MODULE;
  if (modulePath === undefined || modulePath.trim() === "") {
    throw new Error(
      "ZED_E2E_TYPESCRIPT_CLIENT_MODULE must identify the pinned built TypeScript client",
    );
  }
  const loaded: unknown = await import(
    pathToFileURL(path.resolve(modulePath)).href
  );
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    !("downloadDependencyGraph" in loaded) ||
    typeof loaded.downloadDependencyGraph !== "function"
  ) {
    throw new Error("pinned TypeScript client omitted downloadDependencyGraph");
  }
  return loaded.downloadDependencyGraph as DownloadDependencyGraph;
}

function packageGraphPath(org: string, name: string, version: string): string {
  return `${WEB_URL}/bff/dependency-graphs/packages/${encodeURIComponent(org)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

function latestPackageGraphPath(org: string, name: string): string {
  return `${WEB_URL}/bff/dependency-graphs/packages/${encodeURIComponent(org)}/${encodeURIComponent(name)}/latest`;
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
  expected: ExpectedRepresentation,
): Promise<{
  etag: string;
  digest: string;
  body: Buffer;
  headers: Record<string, string>;
}> {
  const response = await request.get(url, { failOnStatusCode: false });
  expect(response.status()).toBe(200);
  const headers = response.headers();
  const body = await response.body();
  const etag = headers.etag;
  const digest = headers[GRAPH_DIGEST_HEADER];
  if (etag === undefined || digest === undefined) {
    throw new Error("graph response omitted its ETag or semantic digest");
  }
  expect(etag).toBe(`"${sha256Hex(body)}"`);
  expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(headers[GRAPH_AUTHORITY_HEADER]).toBe(
    String(expected.authoritative),
  );
  expect(headers["content-type"]).toBe(expected.mediaType);
  expect(headers["cache-control"]).toBe(expected.cacheControl);
  expect(headers["content-disposition"]).toContain(".dependency-graph.");
  expect(Number(headers["content-length"])).toBe(body.byteLength);
  expect(headers.vary.toLowerCase().split(/\s*,\s*/)).toEqual(["accept"]);
  if (expected.selectedVersion !== undefined) {
    expect(headers[SELECTED_VERSION_HEADER]).toBe(expected.selectedVersion);
  }

  const head = await request.head(url, { failOnStatusCode: false });
  expect(head.status()).toBe(200);
  expect((await head.body()).byteLength).toBe(0);
  expectMatchingRepresentationHeaders(
    head.headers(),
    headers,
    "HEAD",
    expected.selectedVersion,
    true,
  );

  const conditional = await request.get(url, {
    // RFC 9110 requires weak comparison for GET/HEAD even though the emitted
    // representation validator itself remains strong.
    headers: { "If-None-Match": `W/${etag}` },
    failOnStatusCode: false,
  });
  expect(conditional.status()).toBe(304);
  expect((await conditional.body()).byteLength).toBe(0);
  expectMatchingRepresentationHeaders(
    conditional.headers(),
    headers,
    "conditional GET",
    expected.selectedVersion,
  );

  const conditionalHead = await request.head(url, {
    headers: { "If-None-Match": `W/${etag}` },
    failOnStatusCode: false,
  });
  expect(conditionalHead.status()).toBe(304);
  expect((await conditionalHead.body()).byteLength).toBe(0);
  expectMatchingRepresentationHeaders(
    conditionalHead.headers(),
    headers,
    "conditional HEAD",
    expected.selectedVersion,
  );
  return { etag, digest, body, headers };
}

test.describe("dependency graph candidate stack", () => {
  test.skip(
    process.env.ZED_E2E_DEPENDENCY_GRAPH_CANDIDATE !== "1",
    "requires the dependency-graph candidate workflow's pinned sibling revisions",
  );

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
    const { digest, body, headers } = await expectImmutableValidator(
      request,
      url,
      {
        mediaType: GRAPH_FORMATS[0].mediaType,
        authoritative: true,
        cacheControl: PUBLIC_IMMUTABLE_CACHE,
      },
    );
    const document = JSON.parse(body.toString("utf8"));
    const serialized = JSON.stringify(document);

    expect(document.schema).toBe("zpkg/dependency-graph/v1");
    expect(document.graph_digest).toBe(digest);
    expect(serialized).toContain("graph-core");
    expect(serialized).toContain("graph-util");
    expect(headers["content-type"]).toBe(GRAPH_FORMATS[0].mediaType);
  });

  test("latest BFF response preserves its selected version on GET, HEAD, and 304", async ({
    request,
  }) => {
    const fixture = await ensureDependencyGraphSeeded();
    const { body, headers } = await expectImmutableValidator(
      request,
      latestPackageGraphPath(fixture.app.org, fixture.app.name),
      {
        mediaType: GRAPH_FORMATS[0].mediaType,
        authoritative: true,
        cacheControl: PUBLIC_LATEST_CACHE,
        selectedVersion: fixture.app.version,
      },
    );
    expect(headers[SELECTED_VERSION_HEADER]).toBe(fixture.app.version);
    expect(body.toString("utf8")).toContain(fixture.app.version);
  });

  test("all text, analytics, and binary representations share a digest", async ({
    request,
  }) => {
    const fixture = await ensureDependencyGraphSeeded();
    const digests = new Set<string>();

    for (const descriptor of GRAPH_FORMATS) {
      const { format, mediaType, authoritative } = descriptor;
      const { body, digest, etag, headers } = await expectImmutableValidator(
        request,
        exportPath(
          fixture.app.org,
          fixture.app.name,
          fixture.app.version,
          format,
        ),
        {
          mediaType,
          authoritative,
          cacheControl: PUBLIC_IMMUTABLE_CACHE,
        },
      );
      expect(body.byteLength, format).toBeGreaterThan(8);
      expect(headers["content-type"], format).toBe(mediaType);
      expect(digest, format).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(etag, format).toBe(`"${sha256Hex(body)}"`);
      digests.add(digest);
    }

    expect(digests.size).toBe(1);
  });

  test("pinned TypeScript client completes a real 200 and weak-validator 304 roundtrip", async () => {
    const fixture = await ensureDependencyGraphSeeded();
    const downloadDependencyGraph = await loadTypeScriptGraphClient();
    const options = {
      baseUrl: API_URL,
      org: fixture.app.org,
      name: fixture.app.name,
      version: fixture.app.version,
      format: "json5",
      token: fixture.token,
      // The candidate stack is isolated on loopback and deliberately uses
      // cleartext HTTP. Production callers retain the client's secure default.
      allowInsecureTransport: true,
      timeoutMs: 10_000,
    } as const;

    const downloaded = await downloadDependencyGraph(options);
    expect(downloaded.status).toBe(200);
    expect(downloaded.notModified).toBe(false);
    expect(downloaded.body.byteLength).toBeGreaterThan(8);
    expect(downloaded.mediaType).toBe(GRAPH_FORMATS[5].mediaType);
    expect(downloaded.authoritative).toBe(true);
    expect(downloaded.graphDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(downloaded.etag).toBe(`"${sha256Hex(downloaded.body)}"`);
    expect(downloaded.filename).toBe(
      `${fixture.app.org}_${fixture.app.name}_${fixture.app.version}.dependency-graph.json5`,
    );

    const notModified = await downloadDependencyGraph({
      ...options,
      ifNoneMatch: `W/${downloaded.etag}`,
    });
    expect(notModified.status).toBe(304);
    expect(notModified.notModified).toBe(true);
    expect(notModified.body.byteLength).toBe(0);
    expect(notModified.etag).toBe(downloaded.etag);
    expect(notModified.graphDigest).toBe(downloaded.graphDigest);
    expect(notModified.authoritative).toBe(downloaded.authoritative);
  });

  test("CLI downloads binary and CSV graphs atomically with byte and semantic validators", async ({
    request,
  }) => {
    const fixture = await ensureDependencyGraphSeeded();
    const directory = mkdtempSync(path.join(os.tmpdir(), "zed-graph-e2e-"));
    const output = path.join(directory, "graph.pb");
    const csvOutput = path.join(directory, "graph.csv");
    try {
      const semanticResponse = await request.get(
        packageGraphPath(
          fixture.app.org,
          fixture.app.name,
          fixture.app.version,
        ),
      );
      expect(semanticResponse.status()).toBe(200);
      const expectedGraphDigest =
        semanticResponse.headers()[GRAPH_DIGEST_HEADER];
      expect(expectedGraphDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

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
      expect(metadata.not_modified).toBe(false);
      expect(metadata.graph_digest).toBe(expectedGraphDigest);
      expect(metadata.content_type).toBe(GRAPH_FORMATS[9].mediaType);
      expect(metadata.output).toBe(output);

      const original = readFileSync(output);
      expect(metadata.bytes).toBe(original.byteLength);
      expect(metadata.etag).toBe(`"${sha256Hex(original)}"`);

      const csvDownloaded = await runZed(
        [
          "graph",
          "package",
          fixture.coordinate,
          "--format",
          "csv",
          "--output",
          csvOutput,
          "--metadata-json",
        ],
        { env: { ZED_PKG_TOKEN: fixture.token } },
      );
      expect(csvDownloaded.code, csvDownloaded.stderr).toBe(0);
      const csvMetadataLine = csvDownloaded.stderr
        .trim()
        .split("\n")
        .filter(Boolean)
        .at(-1);
      expect(csvMetadataLine).toBeTruthy();
      const csvMetadata = JSON.parse(csvMetadataLine!);
      const csvBody = readFileSync(csvOutput);
      expect(csvBody.byteLength).toBeGreaterThan(8);
      expect(csvMetadata.schema).toBe("zed.graph-package-download/v1");
      expect(csvMetadata.package).toBe(fixture.coordinate);
      expect(csvMetadata.format).toBe("csv");
      expect(csvMetadata.authoritative).toBe(false);
      expect(csvMetadata.not_modified).toBe(false);
      expect(csvMetadata.graph_digest).toBe(expectedGraphDigest);
      expect(csvMetadata.content_type).toBe(GRAPH_FORMATS[7].mediaType);
      expect(csvMetadata.bytes).toBe(csvBody.byteLength);
      expect(csvMetadata.etag).toBe(`"${sha256Hex(csvBody)}"`);
      expect(csvMetadata.output).toBe(csvOutput);

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
    const maliciousLabel =
      '<img src=x data-zed-e2e-graph-xss onerror="window.__zedGraphXss=true">';
    const externalRequests: string[] = [];
    const pageErrors: string[] = [];
    const webOrigin = new URL(WEB_URL).origin;
    await page.route(
      packageGraphPath(
        fixture.app.org,
        fixture.app.name,
        fixture.app.version,
      ),
      async (route) => {
        const response = await route.fetch();
        const document = await response.json();
        if (
          !Array.isArray(document.dependencies) ||
          document.dependencies.length === 0
        ) {
          throw new Error("graph fixture did not contain a dependency template");
        }
        document.dependencies.push({
          ...document.dependencies[0],
          name: maliciousLabel,
          requirement: "^9.9.9",
        });
        const body = JSON.stringify(document);
        const headers = response.headers();
        // route.fetch() decodes any transport encoding. Fulfill the modified
        // representation as identity bytes with matching length metadata so
        // the browser client still exercises its normal response validation.
        delete headers["content-encoding"];
        delete headers["transfer-encoding"];
        headers["content-length"] = String(Buffer.byteLength(body));
        headers.etag = `"${sha256Hex(Buffer.from(body))}"`;
        await route.fulfill({
          status: response.status(),
          headers,
          body,
        });
      },
    );
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
    const interactiveGraph = workspace.getByRole("group", {
      name: /interactive package dependency graph/i,
    });
    await expect(interactiveGraph).toBeVisible({ timeout: 20_000 });
    await expect(workspace).toContainText(fixture.app.version);
    await expect(workspace).toContainText("graph-core");
    await expect(workspace).toContainText("graph-util");
    await expect(workspace).toContainText(maliciousLabel);
    await expect(workspace.locator("[data-zed-e2e-graph-xss]")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        Reflect.get(window, "__zedGraphXss") === true,
      ),
    ).toBe(false);

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
    await expect(interactiveGraph).toBeVisible();

    await workspace.locator(".dg-export-menu > summary").click();
    await expect(workspace.locator("a[data-export]")).toHaveCount(
      GRAPH_FORMATS.length,
    );
    for (const { format } of GRAPH_FORMATS) {
      const link = workspace.locator(`a[data-export="${format}"]`);
      await expect(link, `${format} export link`).toHaveCount(1);
      await expect(link, `${format} export link`).toHaveAttribute(
        "href",
        new URL(
          exportPath(
            fixture.app.org,
            fixture.app.name,
            fixture.app.version,
            format,
          ),
        ).pathname,
      );
      await expect(link, `${format} export link`).toBeVisible();
    }
    for (const name of [
      "SVG visible projection",
      "PNG visible projection",
    ]) {
      const control = workspace.getByRole("button", { name, exact: true });
      await expect(control).toBeVisible();
      await expect(control).toBeEnabled();
    }
    await expect(workspace.locator("[data-projection-export]")).toHaveCount(2);
    expect(pageErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
  });
});
