/**
 * Boots the full zed-pkg stack for e2e runs:
 *
 *   postgres (docker) -> migrations -> zed-api-server.rs -> zed-web-server.rs
 *
 * All three browser frameworks (Playwright, Puppeteer, Selenium) and the CLI
 * suites share this one orchestrator so every suite sees the same stack.
 *
 * Environment overrides:
 *   ZED_E2E_API_URL / ZED_E2E_WEB_URL  -- point suites at an already-running
 *                                         stack instead of booting one.
 *   ZED_E2E_PG_IMAGE                  -- pgvector-enabled Postgres image.
 *   ZED_E2E_STORAGE_BACKEND           -- `local` (default), `memory`, or `s3`.
 *   ZED_E2E_STORAGE_MEMORY_MAX_BYTES  -- bounded process-memory total.
 *   For `s3`, the caller's environment must carry S3_BUCKET (plus
 *   S3_ENDPOINT_URL/S3_REGION/S3_FORCE_PATH_STYLE and AWS credentials as
 *   needed); those pass through to the api-server unchanged.
 *   ZED_E2E_KEEP=1                    -- leave the stack up after the run.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  openSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const pexecFile = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const E2E_ROOT = path.resolve(__dirname, "..");
export const REPO_ROOT = path.resolve(E2E_ROOT, "..");

export const API_REPO = path.join(REPO_ROOT, "zed-api-server.rs");
export const WEB_REPO = path.join(REPO_ROOT, "zed-web-server.rs");
export const CLI_REPO = path.join(REPO_ROOT, "zed-cli");

const PG_CONTAINER = process.env.ZED_E2E_PG_CONTAINER ?? "zed-e2e-postgres";
const PG_IMAGE =
  process.env.ZED_E2E_PG_IMAGE ?? "pgvector/pgvector:0.8.6-pg16-bookworm";

/** Ports are overridable so a local run can coexist with an already-deployed
 *  stack — notably the `zed-e2e` kind cluster, whose NodePorts publish the API
 *  and web server on these same defaults. Without an override the two collide
 *  and the harness (correctly) refuses to run. */
function port(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${envVar} must be an integer port 1-65535, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

const PG_PORT = port("ZED_E2E_PG_PORT", 55432);
const API_PORT = port("ZED_E2E_API_PORT", 48080);
const WEB_PORT = port("ZED_E2E_WEB_PORT", 48081);

export const DATABASE_URL = `postgres://zed:zed@127.0.0.1:${PG_PORT}/zed_e2e`;
export const API_URL = process.env.ZED_E2E_API_URL ?? `http://127.0.0.1:${API_PORT}`;
export const WEB_URL = process.env.ZED_E2E_WEB_URL ?? `http://127.0.0.1:${WEB_PORT}`;

const STATE_DIR = path.join(E2E_ROOT, ".stack");
const externalStack = Boolean(process.env.ZED_E2E_API_URL);

let apiProc: ChildProcess | undefined;
let webProc: ChildProcess | undefined;

async function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return pexecFile(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024 });
}

async function waitFor(url: string, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.status < 500) return;
      lastErr = new Error(`${url} -> ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${label} at ${url}: ${lastErr}`);
}

/** True if something is already accepting connections on 127.0.0.1:port. */
function portInUse(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (used: boolean) => {
      sock.destroy();
      resolve(used);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** Wait until 127.0.0.1:port accepts a TCP connection (host-side, not in-container). */
async function waitForPort(port: number, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portInUse(port)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${label} to accept connections on 127.0.0.1:${port}`);
}

async function startPostgres(): Promise<void> {
  await sh("docker", ["rm", "-f", PG_CONTAINER]).catch(() => {});
  await sh("docker", [
    "run", "-d", "--name", PG_CONTAINER,
    "-e", "POSTGRES_USER=zed",
    "-e", "POSTGRES_PASSWORD=zed",
    "-e", "POSTGRES_DB=zed_e2e",
    "-p", `${PG_PORT}:5432`,
    PG_IMAGE,
  ]);
  const deadline = Date.now() + 60_000;
  let ready = false;
  let lastReadinessError: unknown;
  while (Date.now() < deadline) {
    try {
      // `pg_isready` only proves that a server accepts connections; it can
      // return success while the official image's entrypoint is still creating
      // POSTGRES_DB. Require a real query against the target database as well
      // as the host-side TCP listener so migrations cannot race initialization.
      const { stdout } = await sh("docker", [
        "exec", PG_CONTAINER,
        "psql", "-U", "zed", "-d", "zed_e2e",
        "-v", "ON_ERROR_STOP=1", "-Atqc", "select 1",
      ]);
      if (stdout.trim() === "1" && await portInUse(PG_PORT)) {
        ready = true;
        break;
      }
    } catch (error) {
      lastReadinessError = error;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!ready) {
    throw new Error(
      `postgres container ${PG_CONTAINER} (${PG_IMAGE}) did not become query-ready: ${lastReadinessError}`,
    );
  }

  // The API's migrations create the vector extension and an HNSW index. A
  // plain postgres image starts successfully but then makes the API crash at
  // migration time, which used to surface only as a one-minute health timeout.
  // Verify the required extension before compiling or spawning either server.
  const { stdout } = await sh("docker", [
    "exec", PG_CONTAINER,
    "psql", "-U", "zed", "-d", "zed_e2e",
    "-v", "ON_ERROR_STOP=1", "-Atqc",
    "select default_version from pg_available_extensions where name = 'vector'",
  ]);
  const vectorVersion = stdout.trim();
  if (!vectorVersion) {
    throw new Error(
      `postgres image ${PG_IMAGE} does not provide the required pgvector extension`,
    );
  }
  console.log(`postgres ready with pgvector ${vectorVersion} (${PG_IMAGE})`);
}

async function buildServers(): Promise<void> {
  // Debug profile: fast to build, plenty fast to serve e2e traffic.
  await sh("cargo", ["build", "--bin", "zed-api-server"], { cwd: API_REPO });
  await sh("cargo", ["build", "--bin", "zed-web-server"], { cwd: WEB_REPO });
  await sh("cargo", ["build", "--bin", "zed"], { cwd: CLI_REPO });
}

function spawnLogged(name: string, bin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): ChildProcess {
  mkdirSync(STATE_DIR, { recursive: true });
  // Send the server's stdout/stderr straight to a real file descriptor and
  // detach + unref the child. This lets the server outlive the launcher
  // process (the `stack:up` workflow calls process.exit) without leaving it
  // writing to a broken pipe — a broken stdout pipe was corrupting requests.
  const fd = openSync(path.join(STATE_DIR, `${name}.log`), "a");
  const child = spawn(bin, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  child.unref();
  // Record the binary alongside the pid: a bare pid is not a safe kill target
  // once the OS recycles it, so the reaper verifies the live process is still
  // this binary before signalling it.
  writeFileSync(path.join(STATE_DIR, `${name}.pid`), `${child.pid ?? ""}\n${bin}\n`);
  return child;
}

export interface Stack {
  apiUrl: string;
  webUrl: string;
  databaseUrl: string;
  artifactsDir: string;
}

export async function startStack(): Promise<Stack> {
  const artifactsDir = path.join(STATE_DIR, "artifacts");
  if (externalStack) {
    return { apiUrl: API_URL, webUrl: WEB_URL, databaseUrl: DATABASE_URL, artifactsDir };
  }
  // Reap any detached servers left behind by a previous `stack:up` BEFORE we
  // wipe STATE_DIR — otherwise their pidfiles are lost and the orphans keep the
  // ports bound, so the freshly spawned servers fail to bind while `waitFor`
  // happily gets 200s from the stale instance pointed at a now-recreated DB.
  reapPidFiles();
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });

  // Fail fast and clearly on a port collision rather than silently testing
  // against whatever else is bound here. A listener we just SIGKILLed above
  // can linger for a moment, so re-check briefly before declaring a conflict.
  for (const [port, label] of [[API_PORT, "api"], [WEB_PORT, "web"]] as const) {
    if (await portFreesUp(port)) continue;
    throw new Error(
      `port ${port} (${label}) is already in use — a previous stack may still be running; run \`npm run stack:down\``,
    );
  }

  // Past this point we own real resources (a container, detached servers). Any
  // failure must tear them down: Playwright skips globalTeardown when
  // globalSetup throws, so without this the stack leaks for the whole run.
  try {
    return await bootStack(artifactsDir);
  } catch (error) {
    await stopStack().catch(() => {});
    throw error;
  }
}

/** Wait out a just-killed listener; true once `port` is free. */
async function portFreesUp(port: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await portInUse(port))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function bootStack(artifactsDir: string): Promise<Stack> {
  await startPostgres();
  await buildServers();

  const storageBackend = process.env.ZED_E2E_STORAGE_BACKEND ?? "local";
  if (storageBackend !== "local" && storageBackend !== "memory") {
    throw new Error(
      `ZED_E2E_STORAGE_BACKEND must be local or memory, got ${JSON.stringify(storageBackend)}`,
    );
  }
  const storageEnv: NodeJS.ProcessEnv = storageBackend === "memory"
    ? {
        STORAGE_BACKEND: "memory",
        STORAGE_MEMORY_MAX_BYTES:
          process.env.ZED_E2E_STORAGE_MEMORY_MAX_BYTES ?? "268435456",
      }
    : {
        STORAGE_BACKEND: "local",
        STORAGE_LOCAL_DIR: artifactsDir,
      };

  apiProc = spawnLogged("api", path.join(API_REPO, "target/debug/zed-api-server"), [], {
    DATABASE_URL,
    BIND_ADDR: `127.0.0.1:${API_PORT}`,
    // Must match the address clients reach the server on: it becomes the
    // artifact download_url in version metadata. The default localhost:8080
    // would send the CLI to the wrong port.
    PUBLIC_BASE_URL: API_URL,
    ...storageEnv,
    RUST_LOG: "info",
  }, API_REPO);

  await waitFor(`${API_URL}/healthz`, "zed-api-server");

  webProc = spawnLogged("web", path.join(WEB_REPO, "target/debug/zed-web-server"), [], {
    DATABASE_URL,
    BIND_ADDR: `127.0.0.1:${WEB_PORT}`,
    PUBLIC_REGISTRY_URL: API_URL,
    RUST_LOG: "info",
  }, WEB_REPO);

  await waitFor(`${WEB_URL}/healthz`, "zed-web-server");

  return { apiUrl: API_URL, webUrl: WEB_URL, databaseUrl: DATABASE_URL, artifactsDir };
}

/**
 * Mint a publish token via the api server's `create-token` subcommand.
 * Scoped to `org` (also creates the org). The plaintext token is the last
 * non-empty line the command prints.
 *
 * `role` selects the RBAC role (`owner` | `publisher` | `reader`); the server
 * defaults to `owner` when omitted, which is what most suites want.
 */
export async function createToken(name: string, org: string, role?: string): Promise<string> {
  return mintToken(["create-token", "--name", name, "--org", org, ...(role ? ["--role", role] : [])]);
}

/**
 * Mint an **unscoped admin** token (no `--org`): owner-equivalent in every
 * org. Needed to exercise cross-org operations such as claiming a fresh
 * namespace and then reading that namespace's audit log.
 */
export async function createAdminToken(name: string): Promise<string> {
  return mintToken(["create-token", "--name", name]);
}

async function mintToken(args: string[]): Promise<string> {
  const bin = path.join(API_REPO, "target/debug/zed-api-server");
  const { stdout } = await sh(bin, args, {
    env: { DATABASE_URL },
  });
  const lines = stdout.trim().split("\n").filter(Boolean);
  const token = lines[lines.length - 1]?.trim();
  if (!token || !token.startsWith("zpkg_")) {
    throw new Error(`could not parse token from create-token output: ${stdout}`);
  }
  return token;
}

/**
 * Kill any servers recorded in `.stack/*.pid`. This is how orphaned DETACHED
 * servers get reaped: `stack:up` spawns them in one process and `stack:down`
 * runs in a different process where the `apiProc`/`webProc` module globals are
 * undefined, so killing by PID from disk is the only handle we have.
 */
function reapPidFiles(): void {
  let entries: string[];
  try {
    entries = readdirSync(STATE_DIR);
  } catch {
    return; // no state dir yet
  }
  for (const entry of entries) {
    if (!entry.endsWith(".pid")) continue;
    const pidFile = path.join(STATE_DIR, entry);
    const [pidStr = "", bin = ""] = (() => {
      try {
        return readFileSync(pidFile, "utf8").trim().split("\n");
      } catch {
        return [];
      }
    })();
    const pid = Number(pidStr.trim());
    // Always drop the pidfile, even when we decide not to kill: a stale file
    // that outlives its process is exactly what makes a recycled pid dangerous.
    try {
      unlinkSync(pidFile);
    } catch {
      /* already gone */
    }
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!isStillOurProcess(pid, bin.trim())) continue;
    for (const sig of ["SIGTERM", "SIGKILL"] as const) {
      try {
        process.kill(pid, sig);
      } catch {
        break; // already gone (ESRCH) or not ours (EPERM)
      }
    }
  }
}

/**
 * Is `pid` still running the binary we spawned? Guards against killing an
 * unrelated process that inherited a recycled pid. Pidfiles written before
 * the binary was recorded carry no path — treat those as unverifiable and
 * skip them rather than risk a wrong kill (they are reaped by their own
 * process exit or by `docker rm -f` for postgres).
 *
 * Exported for `harness/stack.test.ts`; not part of the harness API.
 */
export function isStillOurProcess(pid: number, bin: string): boolean {
  if (!bin) return false;
  try {
    const args = execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return args.includes(bin);
  } catch {
    return false; // ps failed or the pid is gone
  }
}

export async function stopStack(): Promise<void> {
  if (externalStack || process.env.ZED_E2E_KEEP === "1") return;
  for (const proc of [webProc, apiProc]) {
    if (proc && proc.exitCode === null) {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
  }
  // Also reap detached servers whose in-process handles this process never had
  // (the `stack:down` case).
  reapPidFiles();
  await sh("docker", ["rm", "-f", PG_CONTAINER]).catch(() => {});
}

/** Runs the zed CLI against an isolated ZED_PKG_HOME so the user's real store is untouched. */
export async function runZed(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const home = process.env.ZED_E2E_HOME ?? path.join(STATE_DIR, "zed-pkg-home");
  mkdirSync(home, { recursive: true });
  const bin = path.join(CLI_REPO, "target/debug/zed");
  try {
    const { stdout, stderr } = await pexecFile(bin, args, {
      cwd: opts.cwd ?? os.tmpdir(),
      env: {
        ...process.env,
        ZED_PKG_HOME: home,
        ZED_PKG_REGISTRY: API_URL,
        ...opts.env,
      },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
