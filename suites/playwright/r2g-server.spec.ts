import { expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { API_URL, createToken, runZed } from "../../harness/stack.js";

test.describe("zed r2g server-backed certification", () => {
  test("publishes, installs, smoke-tests, retries identically, and rejects changed immutable bytes", async ({
    request,
  }) => {
    const suffix = `${Date.now().toString(36)}-${process.pid}`;
    const org = `r2g-${suffix}`;
    const name = "server-roundtrip";
    const version = "1.0.0";
    const token = await createToken(`r2g-server-${suffix}`, org, "owner");
    const project = mkdtempSync(path.join(tmpdir(), "zed-r2g-package-"));
    const r2gRoot = mkdtempSync(path.join(tmpdir(), "zed-r2g-workspaces-"));

    const run = () =>
      runZed(["r2g", "--registry-mode", "server", "--clean"], {
        cwd: project,
        env: {
          ZED_PKG_TOKEN: token,
          ZED_PKG_R2G_ROOT: r2gRoot,
        },
      });

    try {
      writeFileSync(
        path.join(project, ".zpkg.toml"),
        `[package]\norg = "${org}"\nname = "${name}"\nversion = "${version}"\ndescription = "server-backed r2g acceptance fixture"\nlicense = "MIT"\n\n[package.repository]\nvcs = "git"\nurl = "https://github.com/${org}/${name}"\n\n[publish]\nsmoke_test = 'test -f "$ZED_PKG_TEST_TARGET/marker.txt" && grep -q server-backed-r2g "$ZED_PKG_TEST_TARGET/marker.txt"'\n`,
      );
      writeFileSync(path.join(project, "LICENSE"), "MIT\n");
      writeFileSync(path.join(project, "marker.txt"), "server-backed-r2g\n");

      const first = await run();
      const firstOutput = `${first.stdout}\n${first.stderr}`;
      expect(first.code, firstOutput).toBe(0);
      expect(firstOutput).toContain("SERVER MODE");
      expect(firstOutput).toContain("artifact installs and its smoke_test succeeds");
      expect(firstOutput).toContain("remains published");

      const workspaceMatch = first.stdout.match(/^r2g: workspace (.+)$/m);
      expect(workspaceMatch, first.stdout).not.toBeNull();
      expect(existsSync(workspaceMatch![1].trim())).toBe(false);

      const metadataResponse = await request.get(
        `${API_URL}/v1/packages/${org}/${name}/versions/${version}`,
      );
      expect(metadataResponse.status()).toBe(200);
      const metadata = (await metadataResponse.json()) as {
        org: string;
        name: string;
        version: string;
        sha256: string;
      };
      expect(metadata).toMatchObject({ org, name, version });
      expect(metadata.sha256).toMatch(/^[0-9a-f]{64}$/);

      const artifact = await request.get(`${API_URL}/v1/artifacts/${metadata.sha256}`);
      expect(artifact.status()).toBe(200);
      expect((await artifact.body()).byteLength).toBeGreaterThan(0);

      const retry = await run();
      const retryOutput = `${retry.stdout}\n${retry.stderr}`;
      expect(retry.code, retryOutput).toBe(0);
      expect(retryOutput).toContain(
        `already published ${org}/${name}@${version} with identical sha256; reusing it`,
      );
      expect(retryOutput).toContain("artifact installs and its smoke_test succeeds");

      // The changed fixture also fails its smoke test. That gives this case a
      // second fail-closed boundary if immutable-version rejection ever drifts.
      writeFileSync(path.join(project, "marker.txt"), "mutated-artifact\n");
      const changed = await run();
      const changedOutput = `${changed.stdout}\n${changed.stderr}`;
      expect(changed.code, changedOutput).not.toBe(0);
      expect(changedOutput).toContain(`${org}/${name}@${version} already exists with sha256`);
      expect(changedOutput).toContain("refusing to replace it with");

      const unchangedResponse = await request.get(
        `${API_URL}/v1/packages/${org}/${name}/versions/${version}`,
      );
      expect(unchangedResponse.status()).toBe(200);
      const unchanged = (await unchangedResponse.json()) as { sha256: string };
      expect(unchanged.sha256).toBe(metadata.sha256);
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(r2gRoot, { recursive: true, force: true });
    }
  });
});
