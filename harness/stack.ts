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
 *   ZED_E2E_KEEP=1                     -- leave the stack up after the run.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, openSync, rmSync } from "node:fs";
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

const PG_CONTAINER = "zed-e2e-postgres";
const PG_PORT = 55432;
const API_PORT = 48080;
const WEB_PORT = 48081;

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

async function startPostgres(): Promise<void> {
  await sh("docker", ["rm", "-f", PG_CONTAINER]).catch(() => {});
  await sh("docker", [
    "run", "-d", "--name", PG_CONTAINER,
    "-e", "POSTGRES_USER=zed",
    "-e", "POSTGRES_PASSWORD=zed",
    "-e", "POSTGRES_DB=zed_e2e",
    "-p", `${PG_PORT}:5432`,
    "postgres:16-alpine",
  ]);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await sh("docker", ["exec", PG_CONTAINER, "pg_isready", "-U", "zed", "-d", "zed_e2e"]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error("postgres container did not become ready");
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
  writeFileSync(path.join(STATE_DIR, `${name}.pid`), String(child.pid ?? ""));
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
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });

  await startPostgres();
  await buildServers();

  apiProc = spawnLogged("api", path.join(API_REPO, "target/debug/zed-api-server"), [], {
    DATABASE_URL,
    BIND_ADDR: `127.0.0.1:${API_PORT}`,
    // Must match the address clients reach the server on: it becomes the
    // artifact download_url in version metadata. The default localhost:8080
    // would send the CLI to the wrong port.
    PUBLIC_BASE_URL: API_URL,
    STORAGE_BACKEND: "local",
    STORAGE_LOCAL_DIR: artifactsDir,
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
 */
export async function createToken(name: string, org: string): Promise<string> {
  const bin = path.join(API_REPO, "target/debug/zed-api-server");
  const { stdout } = await sh(bin, ["create-token", "--name", name, "--org", org], {
    env: { DATABASE_URL },
  });
  const lines = stdout.trim().split("\n").filter(Boolean);
  const token = lines[lines.length - 1]?.trim();
  if (!token || !token.startsWith("zpkg_")) {
    throw new Error(`could not parse token from create-token output: ${stdout}`);
  }
  return token;
}

export async function stopStack(): Promise<void> {
  if (externalStack || process.env.ZED_E2E_KEEP === "1") return;
  for (const proc of [webProc, apiProc]) {
    if (proc && proc.exitCode === null) {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
  }
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
