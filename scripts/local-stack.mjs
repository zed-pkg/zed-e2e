#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'local-stack.json');
const REQUIRED_ROLES = ['api', 'web', 'admin-api', 'admin-web'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const roleKey = (role) => role.toUpperCase().replaceAll('-', '_');

async function loadConfig() {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  if (config.version !== 1 || typeof config.env_prefix !== 'string' || !config.env_prefix) {
    throw new Error('local-stack.json must declare version=1 and a non-empty env_prefix');
  }
  if (!Array.isArray(config.services) || config.services.length !== 4) {
    throw new Error('local-stack.json must declare exactly four services');
  }
  const roles = config.services.map((service) => service.role).sort();
  if (JSON.stringify(roles) !== JSON.stringify([...REQUIRED_ROLES].sort())) {
    throw new Error(`services must be exactly: ${REQUIRED_ROLES.join(', ')}`);
  }
  const ports = new Set();
  for (const service of config.services) {
    if (!service.repo || !service.bin || !service.bind_env || !service.health_path) {
      throw new Error(`service ${service.role} is missing repo/bin/bind_env/health_path`);
    }
    if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) {
      throw new Error(`service ${service.role} has invalid port ${service.port}`);
    }
    if (ports.has(service.port)) throw new Error(`duplicate default port ${service.port}`);
    ports.add(service.port);
    if (service.role.startsWith('admin-') && service.bind_env !== 'ADMIN_BIND_ADDR') {
      throw new Error(`${service.role} must bind through ADMIN_BIND_ADDR`);
    }
  }
  return config;
}

function effectivePort(config, service) {
  const name = `${config.env_prefix}_LOCAL_${roleKey(service.role)}_PORT`;
  const raw = process.env[name];
  if (!raw) return service.port;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer port 1-65535`);
  }
  return value;
}

const serviceUrl = (port) => `http://127.0.0.1:${port}`;

async function tcpInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(400);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function assertSibling(service) {
  const repo = path.resolve(ROOT, service.repo);
  await access(path.join(repo, 'Cargo.toml'));
  return repo;
}

function targetBinary(repo, service) {
  const configured = process.env.CARGO_TARGET_DIR;
  const target = configured ? path.resolve(repo, configured) : path.join(repo, 'target');
  return path.join(target, 'debug', service.bin);
}

async function runChecked(command, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

async function buildService(service, repo) {
  console.log(`[local-stack] build ${service.role}: ${service.bin}`);
  await runChecked('cargo', ['build', '--locked', '--manifest-path', path.join(repo, 'Cargo.toml'), '--bin', service.bin], {
    cwd: repo,
    env: process.env,
  });
}

function urlsFor(config) {
  return Object.fromEntries(config.services.map((service) => [service.role, serviceUrl(effectivePort(config, service))]));
}

function testEnv(config, urls) {
  const prefix = config.env_prefix;
  return {
    ...process.env,
    [`${prefix}_E2E_API_URL`]: urls.api,
    [`${prefix}_E2E_WEB_URL`]: urls.web,
    [`${prefix}_E2E_ADMIN_API_URL`]: urls['admin-api'],
    [`${prefix}_E2E_ADMIN_WEB_URL`]: urls['admin-web'],
    [`${prefix}_E2E_BASE_URL`]: urls.web,
  };
}

function serviceEnv(config, service, urls) {
  const port = effectivePort(config, service);
  const prefix = config.env_prefix;
  const env = {
    ...testEnv(config, urls),
    PORT: String(port),
    [service.bind_env]: `127.0.0.1:${port}`,
    LOCAL_E2E: '1',
  };
  if (service.role === 'web') {
    env.API_URL = urls.api;
    env.PUBLIC_API_URL = urls.api;
    env[`${prefix}_API_URL`] = urls.api;
  }
  if (service.role === 'admin-web') {
    env.ADMIN_API_URL = urls['admin-api'];
    env.ADMIN_API_BASE_URL = urls['admin-api'];
    env[`${prefix}_ADMIN_API_URL`] = urls['admin-api'];
  }
  return env;
}

async function waitForHealth(service, url, child, timeoutMs = 60_000) {
  const target = `${url}${service.health_path}`;
  const deadline = Date.now() + timeoutMs;
  let last = 'not started';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${service.role} exited before becoming healthy (code ${child.exitCode})`);
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(1500) });
      if (response.status < 500) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${service.role} at ${target}: ${last}`);
}

async function startAll(config) {
  const stateDir = path.join(ROOT, config.state_dir ?? '.local-stack');
  await mkdir(stateDir, { recursive: true });
  const urls = urlsFor(config);
  const repos = new Map();
  for (const service of config.services) {
    const port = effectivePort(config, service);
    if (await tcpInUse(port)) throw new Error(`port ${port} for ${service.role} is already in use`);
    repos.set(service.role, await assertSibling(service));
  }
  for (const service of config.services) await buildService(service, repos.get(service.role));

  const running = [];
  try {
    for (const service of config.services) {
      const repo = repos.get(service.role);
      const logPath = path.join(stateDir, `${service.role}.log`);
      const log = createWriteStream(logPath, { flags: 'a' });
      const child = spawn(targetBinary(repo, service), [], {
        cwd: repo,
        env: serviceEnv(config, service, urls),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.once('exit', () => log.end());
      running.push({ service, child, logPath });
      await waitForHealth(service, urls[service.role], child);
      console.log(`[local-stack] ready ${service.role}: ${urls[service.role]} (log: ${logPath})`);
    }
    return { running, urls };
  } catch (error) {
    await stopAll(running);
    throw error;
  }
}

async function stopOne({ child, service }) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const timedOut = await Promise.race([exited.then(() => false), sleep(3000).then(() => true)]);
  if (timedOut && child.exitCode === null) child.kill('SIGKILL');
  console.log(`[local-stack] stopped ${service.role}`);
}

async function stopAll(running) {
  await Promise.allSettled([...running].reverse().map(stopOne));
}

async function runTestCommand(config, urls) {
  const variable = `${config.env_prefix}_LOCAL_TEST_CMD`;
  const command = process.env[variable] ?? config.test_command ?? 'npm test';
  console.log(`[local-stack] test: ${command}`);
  const shell = process.env.SHELL ?? '/bin/sh';
  await runChecked(shell, ['-lc', command], { cwd: ROOT, env: testEnv(config, urls) });
}

async function main() {
  const mode = process.argv[2] ?? 'test';
  const config = await loadConfig();
  if (mode === 'validate') {
    console.log(`[local-stack] valid four-server manifest for ${config.env_prefix}`);
    return;
  }
  if (mode === 'check') {
    for (const service of config.services) await assertSibling(service);
    console.log('[local-stack] all four sibling Cargo workspaces are present');
    return;
  }
  if (!['run', 'test'].includes(mode)) throw new Error('usage: local-stack.mjs [validate|check|run|test]');

  const { running, urls } = await startAll(config);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await stopAll(running);
  };
  process.once('SIGINT', () => void stop().then(() => process.exit(130)));
  process.once('SIGTERM', () => void stop().then(() => process.exit(143)));
  try {
    if (mode === 'test') await runTestCommand(config, urls);
    else {
      console.log('[local-stack] four-server stack is running; Ctrl-C stops it');
      await new Promise((resolve) => { for (const { child } of running) child.once('exit', resolve); });
    }
  } finally {
    await stop();
  }
}

main().catch((error) => {
  console.error(`[local-stack] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
