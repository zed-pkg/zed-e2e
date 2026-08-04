import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';

import {
  allocateStackPorts,
  allocationEnvironment,
} from './allocate-stack-ports.mjs';

function listen(port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('invalid server address'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('free preferred ports are retained and exported', async () => {
  const holders = await Promise.all([listen(), listen(), listen()]);
  await Promise.all(holders.map(({ server }) => close(server)));
  const defaults = { pg: holders[0].port, api: holders[1].port, web: holders[2].port };
  const allocation = await allocateStackPorts({
    env: { ZED_E2E_RUN_ID: 'PR 42 / Matrix' },
    defaults,
  });
  try {
    assert.deepEqual(
      [allocation.pgPort, allocation.apiPort, allocation.webPort],
      [defaults.pg, defaults.api, defaults.web],
    );
    assert.equal(allocation.runId, 'pr-42-matrix');
    assert.equal(allocation.pgContainer, 'zed-e2e-postgres-pr-42-matrix');
    assert.deepEqual(allocationEnvironment(allocation), {
      ZED_E2E_RUN_ID: 'pr-42-matrix',
      ZED_E2E_PG_PORT: String(defaults.pg),
      ZED_E2E_API_PORT: String(defaults.api),
      ZED_E2E_WEB_PORT: String(defaults.web),
      ZED_E2E_PG_CONTAINER: 'zed-e2e-postgres-pr-42-matrix',
      ZED_E2E_API_URL: `http://127.0.0.1:${defaults.api}`,
      ZED_E2E_WEB_URL: `http://127.0.0.1:${defaults.web}`,
    });
  } finally {
    await allocation.release();
  }
});

test('occupied implicit defaults fall back without overlapping', async () => {
  const occupied = await Promise.all([listen(), listen(), listen()]);
  const defaults = { pg: occupied[0].port, api: occupied[1].port, web: occupied[2].port };
  const allocation = await allocateStackPorts({ env: {}, defaults });
  try {
    const selected = [allocation.pgPort, allocation.apiPort, allocation.webPort];
    assert.equal(new Set(selected).size, 3);
    for (const port of selected) {
      assert(!Object.values(defaults).includes(port), `reused occupied port ${port}`);
    }
  } finally {
    await allocation.release();
    await Promise.all(occupied.map(({ server }) => close(server)));
  }
});

test('occupied explicit port fails closed', async () => {
  const occupied = await listen();
  try {
    await assert.rejects(
      allocateStackPorts({
        env: { ZED_E2E_PG_PORT: String(occupied.port) },
        defaults: { pg: 55432, api: 48080, web: 48081 },
      }),
      /cannot reserve pg port/,
    );
  } finally {
    await close(occupied.server);
  }
});

test('invalid and duplicate explicit ports fail before allocation', async () => {
  for (const value of ['0', '65536', '1.5', 'abc', '-1']) {
    await assert.rejects(
      allocateStackPorts({ env: { ZED_E2E_API_PORT: value } }),
      /must be an integer port 1-65535/,
    );
  }
  await assert.rejects(
    allocateStackPorts({
      env: { ZED_E2E_PG_PORT: '41001', ZED_E2E_API_PORT: '41001' },
    }),
    /must be distinct/,
  );
});

test('parallel allocators hold disjoint port sets and container identities', async () => {
  const occupied = await Promise.all([listen(), listen(), listen()]);
  const defaults = { pg: occupied[0].port, api: occupied[1].port, web: occupied[2].port };
  const [first, second] = await Promise.all([
    allocateStackPorts({ env: { ZED_E2E_RUN_ID: 'parallel-a' }, defaults }),
    allocateStackPorts({ env: { ZED_E2E_RUN_ID: 'parallel-b' }, defaults }),
  ]);
  try {
    const firstPorts = new Set([first.pgPort, first.apiPort, first.webPort]);
    const secondPorts = new Set([second.pgPort, second.apiPort, second.webPort]);
    assert.equal(firstPorts.size, 3);
    assert.equal(secondPorts.size, 3);
    assert.deepEqual([...firstPorts].filter((port) => secondPorts.has(port)), []);
    assert.notEqual(first.pgContainer, second.pgContainer);
  } finally {
    await Promise.all([first.release(), second.release()]);
    await Promise.all(occupied.map(({ server }) => close(server)));
  }
});

test('container names are validated and bounded', async () => {
  await assert.rejects(
    allocateStackPorts({ env: { ZED_E2E_PG_CONTAINER: '../unsafe' } }),
    /ZED_E2E_PG_CONTAINER must match/,
  );
  const allocation = await allocateStackPorts({
    env: { ZED_E2E_RUN_ID: 'A'.repeat(200) },
  });
  try {
    assert(allocation.pgContainer.length <= 63);
    assert.match(allocation.pgContainer, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  } finally {
    await allocation.release();
  }
});
