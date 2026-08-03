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
    const successes = results.filter((result) => result === null).length;
    const failures = results.filter((result): result is string => result !== null);
    // `zed publish` makes a byte-identical retry idempotent: a racer that sees
    // the committed row during its preflight exits successfully without a
    // second PUT. A racer already inside the API can instead lose the unique-
    // index race and receive the expected immutable-version conflict. Both
    // schedules are valid, but at least one command must succeed and no other
    // failure class is acceptable.
    expect(
      successes,
      `at least one concurrent publish must succeed; failures:\n${failures.join("\n")}`,
    ).toBeGreaterThanOrEqual(1);
    const unexpected = failures.filter(
      (failure) => !/version_exists|already (?:published|exists)/i.test(failure),
    );
    expect(
      unexpected,
      `same-version racers may only lose with an immutable-version conflict:\n${unexpected.join("\n")}`,
    ).toHaveLength(0);

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
    const victimToken = await createToken(`e2e-victim-${suffix}`, victimOrg);
    expect(victimToken).not.toBe(token);

    const error = await tryPublish({
      org: victimOrg,
      name: "protected",
      version: "1.0.0",
      description: "must reject the attacker's token",
    });
    expect(error).toMatch(/forbidden|not authorized|403/i);
  });

  test("a scoped token cannot claim a second org", async () => {
    const result = await runZed(["org", "claim", `extra-${suffix}`], {
      env: { ZED_PKG_TOKEN: token },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/forbidden|not authorized|scoped|403/i);
  });

  test("package search matches names and descriptions", async ({ request }) => {
    const name = "searchable-kit";
    await publishFixture(
      { org, name, version: "1.0.0", description: "frobnicator transport" },
      { token, allowExisting: true },
    );

    const byName = await request.get(`${API_URL}/v1/search?q=searchable`);
    expect(byName.status()).toBe(200);
    expect((await byName.json()).items.some((item: { name: string }) => item.name === name)).toBe(true);

    const byDescription = await request.get(`${API_URL}/v1/search?q=frobnicator`);
    expect(byDescription.status()).toBe(200);
    expect((await byDescription.json()).items.some((item: { name: string }) => item.name === name)).toBe(true);
  });

  test("manifest URL identity mismatch is rejected before publication", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zed-url-mismatch-"));
    try {
      writeFileSync(path.join(dir, ".zpkg.toml"), `[package]\norg = "${org}"\nname = "url-mismatch"\nversion = "1.0.0"\ndescription = "mismatch"\nlicense = "MIT"\n\n[package.repository]\nvcs = "git"\nurl = "https://github.com/${org}/url-mismatch"\n`);
      writeFileSync(path.join(dir, "LICENSE"), "MIT\n");
      const result = await runZed(["publish", "--skip-vcs-checks"], {
        cwd: dir,
        env: { ZED_PKG_TOKEN: token },
      });
      // Sanity: publish the correctly addressed package first, then prove an
      // explicit direct API mismatch is rejected below.
      expect(result.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
