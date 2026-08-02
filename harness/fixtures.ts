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
      const alreadyExists = /version_exists|already (?:published|exists)/i.test(res.stderr);
      if (opts.allowExisting && alreadyExists) return pkg;
      throw new Error(`publish ${pkg.org}/${pkg.name}@${pkg.version} failed:\n${res.stderr}`);
    }
    return pkg;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One language slice of a polyglot fixture repository. */
export interface PolyglotTarget {
  /** `[targets.<key>]` in the manifest, e.g. `nodejs`. */
  key: string;
  /** Package-relative source root, e.g. `clients/typescript`. */
  dir: string;
  /** Published zed package name. Defaults to `<base>-<key>`. */
  name?: string;
  /** Files written under `dir`, keyed by path relative to it. */
  files: Record<string, string>;
}

/**
 * Publishes a polyglot repository: ONE `zed publish` that fans out into one
 * artifact per `[targets.*]`, plus the whole-repository artifact when
 * `repositoryTarget` is set.
 *
 * This is the browsable counterpart to the `zed-cli` polyglot workflow, which
 * proves the artifacts are well-formed but never puts them in a registry a
 * human can navigate. Here the fan-out lands in the real API server so the
 * browser suites can assert a Java consumer can find the Java package.
 *
 * Returns every package name the publish produced, so callers assert against
 * the real fan-out rather than a hardcoded list that can drift.
 */
export async function publishPolyglotFixture(
  base: PublishedPackage,
  targets: PolyglotTarget[],
  opts: { token: string; repositoryTarget?: string; allowExisting?: boolean },
): Promise<{ base: PublishedPackage; published: string[] }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), `zed-poly-${base.name}-`));
  try {
    let toml =
      `[package]\n` +
      `org = "${base.org}"\n` +
      `name = "${base.name}"\n` +
      `version = "${base.version}"\n` +
      `description = "${base.description}"\n` +
      `license = "MIT"\n\n` +
      `[package.repository]\n` +
      `vcs = "git"\n` +
      `url = "https://github.com/${base.org}/${base.name}"\n`;

    const published: string[] = [];
    // `dir = "."` is the whole-repository artifact: every language in one
    // package, published alongside the isolated slices rather than instead
    // of them. `zed pack` exempts it from the nested-manifest guard.
    if (opts.repositoryTarget) {
      toml += `\n[targets.repository]\ndir = "."\nname = "${opts.repositoryTarget}"\n`;
      published.push(`${base.org}/${opts.repositoryTarget}`);
    }
    for (const t of targets) {
      const name = t.name ?? `${base.name}-${t.key}`;
      toml += `\n[targets.${t.key}]\ndir = "${t.dir}"\nname = "${name}"\n`;
      published.push(`${base.org}/${name}`);
      for (const [rel, contents] of Object.entries(t.files)) {
        const p = path.join(dir, t.dir, rel);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, contents);
      }
    }

    writeFileSync(path.join(dir, ".zpkg.toml"), toml);
    // Hoisted into every slice by `zed pack`; npm, crates.io and RubyGems all
    // surface it, and the polyglot workflow asserts its presence.
    writeFileSync(path.join(dir, "LICENSE"), "MIT\n");

    const res = await runZed(["publish", "--skip-vcs-checks"], {
      cwd: dir,
      env: { ZED_PKG_TOKEN: opts.token },
    });
    if (res.code !== 0) {
      const alreadyExists = /version_exists|already (?:published|exists)/i.test(res.stderr);
      if (!(opts.allowExisting && alreadyExists)) {
        throw new Error(`polyglot publish ${base.org}/${base.name}@${base.version} failed:\n${res.stderr}`);
      }
    }
    return { base, published };
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

/**
 * One repo, four languages, one version — the shape every `*-clients`
 * repository has. Each slice carries its ecosystem's own native manifest at
 * its root, because that is what makes the same slice publishable to npm /
 * PyPI / crates.io / the Go proxy as well as to zed.
 */
export const POLYGLOT_SEED = {
  base: {
    org: "acme",
    name: "acme-clients",
    version: "1.1.2",
    description: "Official polyglot clients for the Acme API",
  } as PublishedPackage,
  repositoryTarget: "acme-clients-repository",
  targets: [
    {
      key: "nodejs",
      dir: "clients/typescript",
      files: {
        "package.json": JSON.stringify(
          { name: "@acme/client", version: "1.1.2", license: "MIT", main: "index.js" },
          null,
          2,
        ),
        "index.js": `module.exports = { greet: (n) => \`hello, \${n}\` };\n`,
      },
    },
    {
      key: "python",
      dir: "clients/python",
      files: {
        "pyproject.toml":
          `[project]\nname = "acme-client"\nversion = "1.1.2"\ndescription = "Acme client"\n`,
        "acme_client/__init__.py": `def greet(name):\n    return f"hello, {name}"\n`,
      },
    },
    {
      key: "golang",
      dir: "clients/go",
      files: {
        "go.mod": `module github.com/acme/acme-clients/clients/go\n\ngo 1.22\n`,
        "acme.go": `package acme\n\nimport "fmt"\n\nfunc Greet(n string) string { return fmt.Sprintf("hello, %s", n) }\n`,
      },
    },
    {
      key: "rust",
      dir: "clients/rust",
      files: {
        "Cargo.toml":
          `[package]\nname = "acme-client"\nversion = "1.1.2"\nedition = "2021"\nlicense = "MIT"\n\n[dependencies]\n`,
        "src/lib.rs": `pub fn greet(n: &str) -> String { format!("hello, {n}") }\n`,
      },
    },
  ] as PolyglotTarget[],
};

let polyglotSeeded: { token: string; published: string[] } | null = null;

/**
 * Publishes POLYGLOT_SEED once per process, under the same cross-process lock
 * as `ensureSeeded` so parallel workers do not race the org claim or publish.
 */
export async function ensurePolyglotSeeded(): Promise<{ token: string; published: string[] }> {
  if (polyglotSeeded) return polyglotSeeded;
  const release = await acquireSeedLock();
  try {
    const token = await createToken(`e2e-poly-${Date.now().toString(36)}`, POLYGLOT_SEED.base.org);
    const { published } = await publishPolyglotFixture(
      POLYGLOT_SEED.base,
      POLYGLOT_SEED.targets,
      {
        token,
        repositoryTarget: POLYGLOT_SEED.repositoryTarget,
        allowExisting: true,
      },
    );
    polyglotSeeded = { token, published };
    return polyglotSeeded;
  } finally {
    release();
  }
}

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
