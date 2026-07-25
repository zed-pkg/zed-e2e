import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { API_URL, createToken, runZed } from "../../harness/stack.js";
import { publishFixture, type PublishedPackage } from "../../harness/fixtures.js";

// Registry-level invariants the basic contract suite doesn't cover: behavior
// under concurrent publishes, latest re-resolution across yank, artifact
// content-addressing round-trip, and cross-org publish authorization.
test.describe("zed-api-server registry semantics", () => {
  const suffix = Date.now().toString(36);
  const org = `reg-${suffix}`;
  let token = "";

  test.beforeAll(async () => {
    token = await createToken(`e2e-reg-${suffix}`, org);
  });

  const tryPublish = async (pkg: PublishedPackage): Promise<string | null> => {
    try {
      await publishFixture(pkg, { token });
      return null;
    } catch (err) {
      return String((err as Error).message ?? err);
    }
  };

  test("concurrent publishes of distinct versions all land", async ({ request }) => {
    const name = "concurrent-distinct";
    // Create the package row first (one sequential publish), so the concurrent
    // batch exercises concurrent VERSION inserts, not a race to lazily create
    // the same package row (covered separately below).
    await publishFixture({ org, name, version: "1.0.0", description: "seed" }, { token, allowExisting: true });

    const versions = ["1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0"];
    const errs = (await Promise.all(
      versions.map((version) => tryPublish({ org, name, version, description: version })),
    )).filter(Boolean);
    expect(errs, `all concurrent version publishes should succeed; failures:\n${errs.join("\n")}`).toHaveLength(0);

    const res = await request.get(`${API_URL}/v1/packages/${org}/${name}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    for (const v of ["1.0.0", ...versions]) expect(body.versions).toContain(v);
  });

  test("concurrent first-publishes of a new package do not lose versions", async ({ request }) => {
    // No pre-created package row: N concurrent publishes of DISTINCT versions
    // of a brand-new package race to create the package. A correct server
    // (get-or-create in a tx / ON CONFLICT) lands every version.
    const name = "concurrent-create";
    const versions = ["1.0.0", "2.0.0", "3.0.0", "4.0.0"];
    const errs = (await Promise.all(
      versions.map((version) => tryPublish({ org, name, version, description: version })),
    )).filter(Boolean);

    const res = await request.get(`${API_URL}/v1/packages/${org}/${name}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const landed = versions.filter((v) => body.versions.includes(v));
    // A correct get-or-create must land EVERY version even when all N requests
    // race to create the package row. Losing any is a package-creation race bug.
    expect(landed.length, `landed ${landed.length}/4; publish failures:\n${errs.join("\n")}`).toBe(4);
  });

  test("concurrent publishes of the SAME version do not corrupt the registry", async ({ request }) => {
    const name = "concurrent-same";
    const results = await Promise.all(
      Array.from({ length: 5 }, () => tryPublish({ org, name, version: "1.0.0", description: "same" })),
    );
    const wins = results.filter(Boolean).length;
    // Versions are immutable: at least one publish commits, and the racers that
    // lose must not create duplicates or corrupt the row.
    expect(wins).toBeGreaterThanOrEqual(1);

    const res = await request.get(`${API_URL}/v1/packages/${org}/${name}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.versions.filter((v: string) => v === "1.0.0").length).toBe(1);

    // The committed artifact is intact and downloadable.
    const ver = await request.get(`${API_URL}/v1/packages/${org}/${name}/versions/1.0.0`);
    expect(ver.status()).toBe(200);
    expect((await ver.json()).sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("latest re-resolves to the highest non-yanked version", async ({ request }) => {
    const name = "latest-track";
    await publishFixture({ org, name, version: "1.0.0", description: "v1" }, { token, allowExisting: true });
    await publishFixture({ org, name, version: "2.0.0", description: "v2" }, { token, allowExisting: true });

    let body = await (await request.get(`${API_URL}/v1/packages/${org}/${name}`)).json();
    expect(body.latest).toBe("2.0.0");

    // Yank the top version; latest must fall back to 1.0.0.
    expect((await runZed(["yank", `${org}/${name}@2.0.0`], { env: { ZED_PKG_TOKEN: token } })).code).toBe(0);
    body = await (await request.get(`${API_URL}/v1/packages/${org}/${name}`)).json();
    expect(body.latest).toBe("1.0.0");

    // The yanked version is still individually fetchable, flagged yanked.
    const ver = await request.get(`${API_URL}/v1/packages/${org}/${name}/versions/2.0.0`);
    expect(ver.status()).toBe(200);
    expect((await ver.json()).yanked).toBe(true);
  });

  test("artifact is content-addressed: version sha resolves to the exact bytes", async ({ request }) => {
    const name = "addressed";
    await publishFixture({ org, name, version: "1.0.0", description: "addr" }, { token, allowExisting: true });
    const ver = await (await request.get(`${API_URL}/v1/packages/${org}/${name}/versions/1.0.0`)).json();
    const sha: string = ver.sha256;

    const art = await request.get(`${API_URL}/v1/artifacts/${sha}`);
    expect(art.status()).toBe(200);
    expect(Number(art.headers()["content-length"])).toBe(ver.size);

    // A well-formed but unknown digest is a clean 404, not a 500.
    const missing = await request.get(`${API_URL}/v1/artifacts/${"0".repeat(64)}`);
    expect(missing.status()).toBe(404);
  });

  test("a token cannot publish to an org owned by someone else", async () => {
    // The victim org EXISTS and is owned by a DIFFERENT token, so this tests
    // authorization (403), not mere non-existence (404 org_not_found).
    const victimOrg = `victim-${suffix}`;
    await createToken(`e2e-victim-${suffix}`, victimOrg); // creates + claims the org under another token
    const dir = mkdtempSync(path.join(os.tmpdir(), "zed-xorg-"));
    try {
      writeFileSync(
        path.join(dir, ".zpkg.toml"),
        `[package]\norg = "${victimOrg}"\nname = "sneaky"\nversion = "1.0.0"\ndescription = "x"\n\n` +
          `[package.repository]\nvcs = "git"\nurl = "https://github.com/${victimOrg}/sneaky"\n`,
      );
      writeFileSync(path.join(dir, "LICENSE"), "MIT\n");
      // Publish to the victim org using OUR (reg-*) token.
      const res = await runZed(["publish", "--skip-vcs-checks"], { cwd: dir, env: { ZED_PKG_TOKEN: token } });
      expect(res.code, "cross-org publish must be rejected").not.toBe(0);
      expect(res.stderr.toLowerCase()).toMatch(/unauth|forbidden|403|401|scope|not allowed|permission/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
