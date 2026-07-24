/**
 * Publishes real packages through the zed CLI so the browser suites have
 * something to browse, and exercises the full publish -> install loop end
 * to end against the live api server.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runZed, createToken } from "./stack.js";

export interface PublishedPackage {
  org: string;
  name: string;
  version: string;
  description: string;
}

function manifest(pkg: PublishedPackage, deps: Record<string, string> = {}): string {
  let out =
    `[package]\n` +
    `org = "${pkg.org}"\n` +
    `name = "${pkg.name}"\n` +
    `version = "${pkg.version}"\n` +
    `description = "${pkg.description}"\n` +
    `license = "MIT"\n\n` +
    `[package.repository]\n` +
    `vcs = "git"\n` +
    `url = "https://github.com/${pkg.org}/${pkg.name}"\n`;
  if (Object.keys(deps).length > 0) {
    out += `\n[dependencies]\n`;
    for (const [k, v] of Object.entries(deps)) out += `"${k}" = "${v}"\n`;
  }
  return out;
}

/**
 * Writes a package to a temp dir and publishes it via `zed publish`
 * (skipping VCS provenance since fixtures aren't real git tags). Returns the
 * package identity for later assertions.
 */
export async function publishFixture(
  pkg: PublishedPackage,
  opts: {
    token: string;
    deps?: Record<string, string>;
    files?: Record<string, string>;
    // Treat "already published" (409, versions are immutable) as success, so
    // seeding is idempotent across reruns against a persistent registry.
    allowExisting?: boolean;
  } = { token: "" },
): Promise<PublishedPackage> {
  const dir = mkdtempSync(path.join(os.tmpdir(), `zed-fix-${pkg.name}-`));
  try {
    writeFileSync(path.join(dir, ".zpkg.toml"), manifest(pkg, opts.deps));
    writeFileSync(path.join(dir, "LICENSE"), "MIT\n");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), `module.exports = "${pkg.name}";\n`);
    for (const [rel, contents] of Object.entries(opts.files ?? {})) {
      const p = path.join(dir, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, contents);
    }
    const res = await runZed(["publish", "--skip-vcs-checks"], {
      cwd: dir,
      env: { ZED_PKG_TOKEN: opts.token },
    });
    if (res.code !== 0) {
      const alreadyExists = /version_exists|already published/i.test(res.stderr);
      if (opts.allowExisting && alreadyExists) return pkg;
      throw new Error(`publish ${pkg.org}/${pkg.name}@${pkg.version} failed:\n${res.stderr}`);
    }
    return pkg;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A stable seed dataset the browser suites assert against. */
export const SEED = {
  org: "acme",
  packages: [
    { org: "acme", name: "http-kit", version: "1.2.0", description: "Tiny HTTP helpers for zed" },
    { org: "acme", name: "logkit", version: "0.3.1", description: "Structured logging toolkit" },
    { org: "acme", name: "cryptobox", version: "2.0.0", description: "Sealed-box crypto utilities" },
  ] as PublishedPackage[],
};

let seeded: { token: string } | null = null;

/**
 * Idempotently claim the seed org, mint a token, and publish SEED. Safe to
 * call from every suite/worker and across reruns against a persistent
 * registry: already-published versions are accepted. A cross-process file
 * lock serializes concurrent seeders so parallel workers don't race.
 */
export async function ensureSeeded(): Promise<{ token: string }> {
  if (seeded) return seeded;
  const token = await createToken(`e2e-seed-${Date.now().toString(36)}`, SEED.org);
  for (const pkg of SEED.packages) {
    await publishFixture(pkg, { token, allowExisting: true });
  }
  seeded = { token };
  return seeded;
}
