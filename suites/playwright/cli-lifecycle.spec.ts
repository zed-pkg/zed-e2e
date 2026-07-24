import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runZed, createToken, API_URL } from "../../harness/stack.js";
import { publishFixture } from "../../harness/fixtures.js";

// End-to-end through the zed CLI against the live api server: claim org,
// publish, then install into a fresh consumer and verify the store/symlink
// layout and the lockfile pin. This is the whole point of the tool.
test.describe("zed CLI lifecycle against the live registry", () => {
  const suffix = Date.now().toString(36);
  const org = `cli-${suffix}`;
  let token = "";

  test.beforeAll(async () => {
    token = await createToken(`e2e-cli-${suffix}`, org);
  });

  test("org claim is reported by the CLI", async () => {
    const res = await runZed(["org", "claim", org], { env: { ZED_PKG_TOKEN: token } });
    expect(res.code, res.stderr).toBe(0);
    // createToken already created the org, so either "claimed" or
    // "already exists" is a pass; the org slug must appear either way.
    expect(res.stdout).toContain(org);
    expect(res.stdout).toMatch(/claimed|already exists/);
  });

  test("publish then install pins the exact artifact in the lockfile", async () => {
    const dep = { org, name: "leaf", version: "1.0.0", description: "leaf dep" };
    await publishFixture(dep, { token });

    const root = { org, name: "app", version: "1.0.0", description: "root app" };
    await publishFixture(root, { token, deps: { [`${org}/leaf`]: "^1.0.0" } });

    const consumer = mkdtempSync(path.join(os.tmpdir(), "zed-consumer-"));
    try {
      writeFileSync(
        path.join(consumer, ".zpkg.toml"),
        `[package]\norg = "local"\nname = "consumer"\nversion = "0.0.0"\n\n` +
          `[package.repository]\nvcs = "git"\nurl = "https://github.com/local/consumer"\n\n` +
          `[dependencies]\n"${org}/app" = "^1.0.0"\n`,
      );
      const res = await runZed(["install"], { cwd: consumer });
      expect(res.code, res.stderr).toBe(0);

      // Transitive dep resolved and linked, pnpm-style, into zed_modules.
      const appLink = path.join(consumer, "zed_modules", org, "app");
      const leafLink = path.join(consumer, "zed_modules", org, "leaf");
      expect(existsSync(appLink)).toBeTruthy();
      expect(existsSync(leafLink)).toBeTruthy();
      expect(lstatSync(appLink).isSymbolicLink()).toBeTruthy();

      // Lockfile pins both packages with a sha256.
      const lock = readFileSync(path.join(consumer, ".zpkg.lock"), "utf8");
      expect(lock).toContain(`name = "app"`);
      expect(lock).toContain(`name = "leaf"`);
      expect(lock).toMatch(/sha256 = "[0-9a-f]{64}"/);

      // --frozen reinstall passes against the just-written lockfile.
      const frozen = await runZed(["install", "--frozen"], { cwd: consumer });
      expect(frozen.code, frozen.stderr).toBe(0);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  test("copy install-mode produces a symlink-free tree for containers", async () => {
    const pkg = { org, name: "copyme", version: "1.0.0", description: "copy mode" };
    await publishFixture(pkg, { token });

    const consumer = mkdtempSync(path.join(os.tmpdir(), "zed-copy-"));
    try {
      writeFileSync(
        path.join(consumer, ".zpkg.toml"),
        `[package]\norg = "local"\nname = "c"\nversion = "0.0.0"\n\n` +
          `[package.repository]\nvcs = "git"\nurl = "https://github.com/local/c"\n\n` +
          `[dependencies]\n"${org}/copyme" = "^1.0.0"\n`,
      );
      const res = await runZed(["install", "--install-mode", "copy"], { cwd: consumer });
      expect(res.code, res.stderr).toBe(0);
      const link = path.join(consumer, "zed_modules", org, "copyme");
      expect(lstatSync(link).isSymbolicLink()).toBeFalsy();
      expect(existsSync(path.join(link, ".zpkg.toml"))).toBeTruthy();
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  test("immutability: re-publishing an existing version is refused", async () => {
    const pkg = { org, name: "immutable", version: "1.0.0", description: "v1" };
    await publishFixture(pkg, { token });
    // Second publish of the same org/name@version must fail (409).
    const dir = mkdtempSync(path.join(os.tmpdir(), "zed-immut-"));
    try {
      writeFileSync(
        path.join(dir, ".zpkg.toml"),
        `[package]\norg = "${org}"\nname = "immutable"\nversion = "1.0.0"\ndescription = "v1-again"\n\n` +
          `[package.repository]\nvcs = "git"\nurl = "https://github.com/${org}/immutable"\n`,
      );
      writeFileSync(path.join(dir, "LICENSE"), "MIT\n");
      const res = await runZed(["publish", "--skip-vcs-checks"], {
        cwd: dir,
        env: { ZED_PKG_TOKEN: token },
      });
      expect(res.code).not.toBe(0);
      expect(res.stderr.toLowerCase()).toMatch(/exist|409|conflict/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("yank hides a version from fresh resolution", async () => {
    await publishFixture({ org, name: "yankable", version: "1.0.0", description: "v1" }, { token });
    await publishFixture({ org, name: "yankable", version: "1.1.0", description: "v11" }, { token });

    const yankRes = await runZed(["yank", `${org}/yankable@1.1.0`], { env: { ZED_PKG_TOKEN: token } });
    expect(yankRes.code, yankRes.stderr).toBe(0);

    // A fresh install of ^1 must now resolve to 1.0.0, not the yanked 1.1.0.
    const consumer = mkdtempSync(path.join(os.tmpdir(), "zed-yank-"));
    try {
      writeFileSync(
        path.join(consumer, ".zpkg.toml"),
        `[package]\norg = "local"\nname = "y"\nversion = "0.0.0"\n\n` +
          `[package.repository]\nvcs = "git"\nurl = "https://github.com/local/y"\n\n` +
          `[dependencies]\n"${org}/yankable" = "^1"\n`,
      );
      const res = await runZed(["install"], { cwd: consumer });
      expect(res.code, res.stderr).toBe(0);
      const lock = readFileSync(path.join(consumer, ".zpkg.lock"), "utf8");
      expect(lock).toContain(`version = "1.0.0"`);
      expect(lock).not.toContain(`version = "1.1.0"`);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  test("find searches the live registry", async () => {
    await publishFixture({ org, name: "findable-widget", version: "1.0.0", description: "searchable" }, { token });
    const res = await runZed(["find", "findable-widget"], { env: { ZED_PKG_REGISTRY: API_URL } });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain("findable-widget");
  });
});
