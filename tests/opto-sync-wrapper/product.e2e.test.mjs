import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const profilePath = process.env.OPTO_SYNC_PROFILE;
assert.ok(profilePath, 'OPTO_SYNC_PROFILE must point at the product E2E profile');
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));

const require = createRequire(import.meta.url);
const sdk = require('../dist/index.js');
const {
  OptoSyncClient,
  createOptoSyncClient,
  initOptoSync,
  SYNC_STATUS,
  reconcileIncoming,
  engineVersion,
} = sdk;

async function deleteDatabase(name) {
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

async function openClient(databaseName) {
  if (typeof initOptoSync === 'function') await initOptoSync();
  if (typeof createOptoSyncClient === 'function') {
    return createOptoSyncClient({ databaseName, stampUpdatedAt: false });
  }
  return new OptoSyncClient({ databaseName, stampUpdatedAt: false });
}

test('the downstream profile keeps product policy above the shared engine', () => {
  assert.equal(profile.dependency.package, 'opto-sync/opto-sync-clients');
  assert.equal(profile.dependency.range, '^0.2.0');
  assert.ok(profile.collections.length > 0);
  assert.ok(profile.writeStrategies.includes('queuedOptimistic'));
  assert.ok(profile.writeStrategies.includes('remoteConfirmed'));
  assert.ok(profile.domainGuards.length > 0);
  assert.ok(profile.persistence.web.includes('indexeddb'));
  assert.ok(profile.persistence.mobile.includes('sqlite'));
  assert.ok(profile.persistence.backend.includes('postgres'));
  assert.ok(profile.persistence.backend.includes('supabase'));
});

test('a product mutation survives restart, keeps a stable protocol id, and never flickers to a stale server value', async (t) => {
  const databaseName = `opto-downstream-${profile.repository.replaceAll('/', '-')}`;
  const collection = profile.collections[0];
  const recordId = 'wrapper-record-1';
  const pendingPayload = {
    id: recordId,
    title: 'edited offline',
    product: profile.repository,
    updatedAt: 5000,
  };

  await deleteDatabase(databaseName);
  t.after(() => deleteDatabase(databaseName));

  const client = await openClient(databaseName);
  const mutationId = await client.queueMutation(collection, recordId, pendingPayload);
  const firstPush = await client.protocolPushRequest();
  const replayedPush = await client.protocolPushRequest();
  assert.deepEqual(
    firstPush.mutations.map((mutation) => mutation.mutationId),
    replayedPush.mutations.map((mutation) => mutation.mutationId),
    'retrying a push must reuse mutation identities',
  );
  client.db.close();

  const reopened = new OptoSyncClient({ databaseName, stampUpdatedAt: false });
  const pendingAfterRestart = await reopened.pendingMutations();
  assert.equal(pendingAfterRestart.length, 1);
  assert.equal(pendingAfterRestart[0].tableName, collection);
  assert.equal(pendingAfterRestart[0].recordId, recordId);
  assert.deepEqual(JSON.parse(pendingAfterRestart[0].jsonPayload), pendingPayload);

  const staleServerEcho = {
    id: recordId,
    title: 'stale server value',
    product: profile.repository,
    updatedAt: 10,
  };
  const visible = reopened.reconcileIncoming(
    collection,
    recordId,
    staleServerEcho,
    pendingPayload,
  );
  assert.equal(visible.title, 'edited offline');
  assert.equal(visible.updatedAt, 5000);

  await reopened.markMutation(mutationId, SYNC_STATUS.SYNCED);
  assert.equal((await reopened.pendingMutations()).length, 0);
  reopened.db.close();
});

test('timestamp conflict and tombstone rules are deterministic in the installed engine', async () => {
  if (typeof initOptoSync === 'function') await initOptoSync();

  const local = { id: 'conflict-1', value: 'new local', updatedAt: 200 };
  const staleIncoming = { id: 'conflict-1', value: 'old server', updatedAt: 100 };
  assert.deepEqual(reconcileIncoming(local, staleIncoming), local);

  const staleLiveRecord = {
    id: 'deleted-1',
    value: 'must not resurrect',
    tombstone: false,
    updatedAt: 100,
  };
  const newerTombstone = {
    id: 'deleted-1',
    value: null,
    tombstone: true,
    deletedAt: 200,
    updatedAt: 200,
  };
  const tombstoneWinner = reconcileIncoming(staleLiveRecord, newerTombstone);
  assert.equal(tombstoneWinner.tombstone, true);
  assert.equal(tombstoneWinner.deletedAt, 200);
  assert.equal(tombstoneWinner.value, null);

  assert.match(String(engineVersion()), /^\d+\.\d+\.\d+/);
});
