import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runZed, createToken } from "../../harness/stack.js";
import { publishFixture } from "../../harness/fixtures.js";

// Deeper CLI behaviors beyond the basic publish->install path in
// cli-lifecycle.spec.ts: semver range resolution, transitive/diamond graphs,
// yank + restore, manifest mutation (add/remove), frozen drift detection, and
// deterministic packing. Each suite mints its own org so runs are isolated and
// re-runnable against a persistent registry.
test.describe("zed CLI advanced", () => {
  const suffix = Date.now().toString(36);
  const org = `adv-${suffix}`;
  let token = "";

  test.beforeAll(async () => {
    token = await createToken(`e2e-adv-${suffix}`, org);
  });

  /** Write a consumer project depending on `deps` and return its dir. */
  function consumer(deps: Record<string, string>): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zed-adv-"));
    const lines = Object.entries(deps).map(([k, v]) => `"${k}" = "${v}"`).join("\n");
    writeFileSync(
      path.join(dir, ".zpkg.toml"),
      `[package]\norg = "local"\nname = "consumer"\nversion = "0.0.0"\n\n` +
        `[package.repository]\nvcs = "git"\nurl = "https://github.com/local/consumer"\n\n` +
        `[dependencies]\n${lines}\n`,
    );
    return dir;
  }

  test("semver range resolves to the highest matching version", async () => {
    for (const version of ["1.0.0", "1.1.0", "1.2.0", "2.0.0"]) {
      await publishFixture({ org, name: "ranged", version, description: `v${version}` }, { token, allowExisting: true });
    }
    const dir = consumer({ [`${org}/ranged`]: "^1.0.0" });
    try {
      const res = await runZed(["install"], { cwd: dir });
      expect(res.code, res.stderr).toBe(0);
      const lock = readFileSync(path.join(dir, ".zpkg.lock"), "utf8");
      // ^1.0.0 must pick the highest 1.x (1.2.0), never the 2.0.0 major bump.
      expect(lock).toContain(`version = "1.2.0"`);
      expect(lock).not.toContain(`version = "2.0.0"`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exact-version pin resolves that version", async () => {
    await publishFixture({ org, name: "ranged", version: "2.0.0", description: "v2" }, { token, allowExisting: true });
    const dir = consumer({ [`${org}/ranged`]: "2.0.0" });
    try {
      const res = await runZed(["install"], { cwd: dir });
      expect(res.code, res.stderr).toBe(0);
      expect(readFileSync(path.join(dir, ".zpkg.lock"), "utf8")).toContain(`version = "2.0.0"`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("diamond dependency graph resolves every node once", async () => {
    // A -> {B, C}; B -> D; C -> D. Installing A must materialize all four.
    await publishFixture({ org, name: "d-base", version: "1.0.0", description: "D" }, { token, allowExisting: true });
    await publishFixture({ org, name: "d-left", version: "1.0.0", description: "B" }, { token, deps: { [`${org}/d-base`]: "^1.0.0" }, allowExisting: true });
    await publishFixture({ org, name: "d-right", version: "1.0.0", description: "C" }, { token, deps: { [`${org}/d-base`]: "^1.0.0" }, allowExisting: true });
    await publishFixture({ org, name: "d-top", version: "1.0.0", description: "A" }, { token, deps: { [`${org}/d-left`]: "^1.0.0", [`${org}/d-right`]: "^1.0.0" }, allowExisting: true });

    const dir = consumer({ [`${org}/d-top`]: "^1.0.0" });
    try {
      const res = await runZed(["install"], { cwd: dir });
      expect(res.code, res.stderr).toBe(0);
      for (const name of ["d-top", "d-left", "d-right", "d-base"]) {
        expect(existsSync(path.join(dir, "zed_modules", org, name)), `${name} linked`).toBeTruthy();
      }
      // The shared transitive dep D appears exactly once in the lock.
      const lock = readFileSync(path.join(dir, ".zpkg.lock"), "utf8");
      expect(lock.match(/name = "d-base"/g)?.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("yank then --undo restores the version to fresh resolution", async () => {
    await publishFixture({ org, name: "restorable", version: "1.0.0", description: "v1" }, { token, allowExisting: true });
    await publishFixture({ org, name: "restorable", version: "1.1.0", description: "v11" }, { token, allowExisting: true });

    // Yank 1.1.0 -> fresh ^1 resolves 1.0.0.
    expect((await runZed(["yank", `${org}/restorable@1.1.0`], { env: { ZED_PKG_TOKEN: token } })).code).toBe(0);
    let dir = consumer({ [`${org}/restorable`]: "^1" });
    try {
      await runZed(["install"], { cwd: dir });
      expect(readFileSync(path.join(dir, ".zpkg.lock"), "utf8")).toContain(`version = "1.0.0"`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Restore 1.1.0 -> fresh ^1 resolves 1.1.0 again.
    const undo = await runZed(["yank", `${org}/restorable@1.1.0`, "--undo"], { env: { ZED_PKG_TOKEN: token } });
    expect(undo.code, undo.stderr).toBe(0);
    dir = consumer({ [`${org}/restorable`]: "^1" });
    try {
      await runZed(["install"], { cwd: dir });
      expect(readFileSync(path.join(dir, ".zpkg.lock"), "utf8")).toContain(`version = "1.1.0"`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("add then remove mutates the manifest and the installed tree", async () => {
    await publishFixture({ org, name: "addable", version: "1.0.0", description: "addable" }, { token, allowExisting: true });
    const dir = mkdtempSync(path.join(os.tmpdir(), "zed-add-"));
    try {
      writeFileSync(
        path.join(dir, ".zpkg.toml"),
        `[package]\norg = "local"\nname = "c"\nversion = "0.0.0"\n\n` +
          `[package.repository]\nvcs = "git"\nurl = "https://github.com/local/c"\n`,
      );
      const add = await runZed(["add", `${org}/addable`], { cwd: dir });
      expect(add.code, add.stderr).toBe(0);
      expect(readFileSync(path.join(dir, ".zpkg.toml"), "utf8")).toContain(`${org}/addable`);
      const link = path.join(dir, "zed_modules", org, "addable");
      expect(existsSync(link)).toBeTruthy();
      // Linked pnpm-style, and the lockfile pins the added dependency.
      expect(lstatSync(link).isSymbolicLink()).toBeTruthy();
      expect(readFileSync(path.join(dir, ".zpkg.lock"), "utf8")).toContain(`name = "addable"`);

      const remove = await runZed(["remove", `${org}/addable`], { cwd: dir });
      expect(remove.code, remove.stderr).toBe(0);
      expect(readFileSync(path.join(dir, ".zpkg.toml"), "utf8")).not.toContain(`${org}/addable`);
      expect(existsSync(link), "remove unlinks the package from zed_modules").toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--frozen fails when the manifest drifts from the lockfile", async () => {
    await publishFixture({ org, name: "frozen-a", version: "1.0.0", description: "a" }, { token, allowExisting: true });
    await publishFixture({ org, name: "frozen-b", version: "1.0.0", description: "b" }, { token, allowExisting: true });
    const dir = consumer({ [`${org}/frozen-a`]: "^1.0.0" });
    try {
      expect((await runZed(["install"], { cwd: dir })).code).toBe(0);
      // Introduce drift: add a dependency the lockfile has never seen.
      writeFileSync(
        path.join(dir, ".zpkg.toml"),
        `[package]\norg = "local"\nname = "consumer"\nversion = "0.0.0"\n\n` +
          `[package.repository]\nvcs = "git"\nurl = "https://github.com/local/consumer"\n\n` +
          `[dependencies]\n"${org}/frozen-a" = "^1.0.0"\n"${org}/frozen-b" = "^1.0.0"\n`,
      );
      const frozen = await runZed(["install", "--frozen"], { cwd: dir });
      expect(frozen.code, "drift under --frozen must fail").not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pack is deterministic (same inputs -> same sha256)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zed-pack-"));
    try {
      writeFileSync(
        path.join(dir, ".zpkg.toml"),
        `[package]\norg = "${org}"\nname = "packable"\nversion = "3.1.4"\ndescription = "det"\n\n` +
          `[package.repository]\nvcs = "git"\nurl = "https://github.com/${org}/packable"\n`,
      );
      writeFileSync(path.join(dir, "LICENSE"), "MIT\n");
      const sha = async () => {
        const res = await runZed(["pack"], { cwd: dir });
        expect(res.code, res.stderr).toBe(0);
        const m = (res.stdout + res.stderr).match(/[0-9a-f]{64}/);
        expect(m, "pack should print a sha256").toBeTruthy();
        return m![0];
      };
      expect(await sha()).toBe(await sha());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
