import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runZed, createToken } from "../../harness/stack.js";

// CLI verbs not covered by cli-lifecycle (publish/install/yank/find) or
// cli-advanced (semver ranges, add/remove, --frozen, pack): scaffolding a new
// project with `init` and persisting a token with `login`.
test.describe("zed CLI: init + login", () => {
  const suffix = Date.now().toString(36);
  const org = `cli3-${suffix}`;
  let token = "";

  test.beforeAll(async () => {
    token = await createToken(`e2e-cli3-${suffix}`, org);
  });

  test("init writes a manifest whose package identity matches the directory", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "zed-init-"));
    const proj = path.join(base, "initproj"); // a valid package name (no dots)
    mkdirSync(proj);
    try {
      const res = await runZed(["init"], { cwd: proj });
      expect(res.code, res.stderr).toBe(0);
      expect(res.stdout).toContain("wrote .zpkg.toml");
      const manifest = readFileSync(path.join(proj, ".zpkg.toml"), "utf8");
      expect(manifest).toContain(`name = "initproj"`);
      expect(manifest).toContain("[package.repository]");
      expect(manifest).toContain("[dependencies]");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("login saves a token that later publishes without ZED_PKG_TOKEN in the environment", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "zed-login-home-"));
    try {
      // `zed login` reads the token from ZED_PKG_TOKEN and persists it to
      // credentials.toml under this isolated home.
      const login = await runZed(["login"], { env: { ZED_PKG_HOME: home, ZED_PKG_TOKEN: token } });
      expect(login.code, login.stderr).toBe(0);
      expect(existsSync(path.join(home, "credentials.toml"))).toBeTruthy();

      // Now publish WITHOUT the token in the env — it must come from saved creds.
      const dir = mkdtempSync(path.join(os.tmpdir(), "zed-login-pub-"));
      try {
        writeFileSync(
          path.join(dir, ".zpkg.toml"),
          `[package]\norg = "${org}"\nname = "viacreds"\nversion = "1.0.0"\ndescription = "saved-cred publish"\nlicense = "MIT"\n\n` +
            `[package.repository]\nvcs = "git"\nurl = "https://github.com/${org}/viacreds"\n`,
        );
        writeFileSync(path.join(dir, "LICENSE"), "MIT\n");
        const pub = await runZed(["publish", "--skip-vcs-checks"], { cwd: dir, env: { ZED_PKG_HOME: home } });
        expect(pub.code, pub.stderr).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
