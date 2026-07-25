/**
 * Publishes real packages through the zed CLI so the browser suites have
 * something to browse, and exercises the full publish -> install loop end
 * to end against the live api server.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, openSync, closeSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runZed, createToken } from "./stack.js";

const SEED_LOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".stack", "seed.lock");

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
      // The CLI now distinguishes a retry-safe byte-identical publish from a
      // same-version/different-artifact conflict. Both are an existing
      // immutable version for fixtures that explicitly opt into reuse.
      const alreadyExists = /version_exists|already published|already exists/i.test(res.stderr);
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A real cross-process lock via O_EXCL file creation (atomic on POSIX). A stale
 * lock older than `staleMs` is reclaimed so a crashed seeder can't wedge the
 * suite forever. Returns a release fn.
 */
async function acquireSeedLock(staleMs = 120_000, timeoutMs = 180_000): Promise<() => void> {
  mkdirSync(path.dirname(SEED_LOCK), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(SEED_LOCK, "wx"); // fails if the file already exists
      return () => {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
        rmSync(SEED_LOCK, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Held by someone else — reclaim if stale, else wait.
      try {
        if (Date.now() - statSync(SEED_LOCK).mtimeMs > staleMs) {
          rmSync(SEED_LOCK, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat — retry immediately
      }
      if (Date.now() > deadline) throw new Error("timed out acquiring seed lock");
      await sleep(150);
    }
  }
}

/**
 * Idempotently claim the seed org, mint a token, and publish SEED. Safe to
 * call from every suite/worker and across reruns against a persistent
 * registry: already-published versions are accepted. A cross-process O_EXCL
 * file lock (see acquireSeedLock) serializes concurrent seeders so parallel
 * workers don't race the org-claim / publish.
 */
export async function ensureSeeded(): Promise<{ token: string }> {
  if (seeded) return seeded;
  const release = await acquireSeedLock();
  try {
    const token = await createToken(`e2e-seed-${Date.now().toString(36)}`, SEED.org);
    for (const pkg of SEED.packages) {
      await publishFixture(pkg, { token, allowExisting: true });
    }
    seeded = { token };
    return seeded;
  } finally {
    release();
  }
}
