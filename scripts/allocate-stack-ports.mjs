#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import net from 'node:net';

const DEFAULTS = Object.freeze({
  pg: 55432,
  api: 48080,
  web: 48081,
});

const ENV_NAMES = Object.freeze({
  pg: 'ZED_E2E_PG_PORT',
  api: 'ZED_E2E_API_PORT',
  web: 'ZED_E2E_WEB_PORT',
});

function parsePort(raw, name) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!/^[0-9]+$/.test(String(raw))) {
    throw new Error(`${name} must be an integer port 1-65535, got ${JSON.stringify(raw)}`);
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer port 1-65535, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function sanitizeRunId(raw) {
  const normalized = String(raw ?? 'local')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 38);
  return normalized || 'local';
}

function defaultRunId(env = process.env) {
  if (env.ZED_E2E_RUN_ID) return sanitizeRunId(env.ZED_E2E_RUN_ID);
  const github = [env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT, env.GITHUB_JOB]
    .filter(Boolean)
    .join('-');
  return sanitizeRunId(github || `local-${process.pid}`);
}

function containerName(runId, explicit) {
  if (explicit) {
    const value = String(explicit);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(value)) {
      throw new Error(
        `ZED_E2E_PG_CONTAINER must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}, got ${JSON.stringify(value)}`,
      );
    }
    return value;
  }
  return `zed-e2e-postgres-${runId}`.slice(0, 63).replace(/[_.-]+$/g, '');
}

function reserve(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('port reservation returned an invalid address'));
        return;
      }
      resolve({ port: address.port, server });
    });
  });
}

async function reservePreferred(preferred, explicit, label) {
  try {
    return await reserve(preferred);
  } catch (error) {
    if (explicit || error?.code !== 'EADDRINUSE') {
      const detail = error?.code ? ` (${error.code})` : '';
      throw new Error(`cannot reserve ${label} port ${preferred}${detail}: ${error?.message ?? error}`);
    }
    return reserve(0);
  }
}

async function closeReservation(reservation) {
  if (!reservation?.server?.listening) return;
  await new Promise((resolve, reject) => {
    reservation.server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function allocateStackPorts({ env = process.env, defaults = DEFAULTS } = {}) {
  const explicit = Object.fromEntries(
    Object.entries(ENV_NAMES).map(([key, name]) => [key, parsePort(env[name], name)]),
  );
  const explicitValues = Object.values(explicit).filter((value) => value !== null);
  if (new Set(explicitValues).size !== explicitValues.length) {
    throw new Error('explicit ZED_E2E PostgreSQL/API/web ports must be distinct');
  }

  const reservations = [];
  const selected = {};
  try {
    for (const key of ['pg', 'api', 'web']) {
      const requested = explicit[key] ?? defaults[key];
      let reservation = await reservePreferred(requested, explicit[key] !== null, key);
      while (Object.values(selected).includes(reservation.port)) {
        await closeReservation(reservation);
        if (explicit[key] !== null) {
          throw new Error(`explicit ${ENV_NAMES[key]} duplicates another selected port`);
        }
        reservation = await reserve(0);
      }
      reservations.push(reservation);
      selected[key] = reservation.port;
    }
  } catch (error) {
    await Promise.allSettled(reservations.map(closeReservation));
    throw error;
  }

  const runId = defaultRunId(env);
  return {
    runId,
    pgPort: selected.pg,
    apiPort: selected.api,
    webPort: selected.web,
    pgContainer: containerName(runId, env.ZED_E2E_PG_CONTAINER),
    async release() {
      await Promise.all(reservations.map(closeReservation));
    },
  };
}

export function allocationEnvironment(allocation) {
  return {
    ZED_E2E_RUN_ID: allocation.runId,
    ZED_E2E_PG_PORT: String(allocation.pgPort),
    ZED_E2E_API_PORT: String(allocation.apiPort),
    ZED_E2E_WEB_PORT: String(allocation.webPort),
    ZED_E2E_PG_CONTAINER: allocation.pgContainer,
    ZED_E2E_API_URL: `http://127.0.0.1:${allocation.apiPort}`,
    ZED_E2E_WEB_URL: `http://127.0.0.1:${allocation.webPort}`,
  };
}

function parseCli(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error('usage: allocate-stack-ports.mjs [--github-env PATH] -- COMMAND [ARG ...]');
  }
  let githubEnv = process.env.GITHUB_ENV ?? null;
  for (let index = 0; index < separator; index += 1) {
    const token = argv[index];
    if (token === '--github-env') {
      githubEnv = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    throw new Error(`unknown option ${JSON.stringify(token)}`);
  }
  if (!githubEnv) throw new Error('--github-env PATH or GITHUB_ENV is required');
  return { githubEnv, command: argv.slice(separator + 1) };
}

async function runCommand(command, env) {
  const [program, ...args] = command;
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      env,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${program} terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function main() {
  const { githubEnv, command } = parseCli(process.argv.slice(2));
  const allocation = await allocateStackPorts();
  const persisted = allocationEnvironment(allocation);
  await appendFile(
    githubEnv,
    `${Object.entries(persisted).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );

  const childEnv = { ...process.env, ...persisted };
  // The stack must boot locally from the selected numeric ports. URL overrides
  // are persisted only for later consumer steps, where they deliberately mark
  // the already-running stack as external.
  delete childEnv.ZED_E2E_API_URL;
  delete childEnv.ZED_E2E_WEB_URL;

  await allocation.release();
  const code = await runCommand(command, childEnv);
  process.exitCode = code;
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  main().catch((error) => {
    console.error(`stack port allocation failed: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
