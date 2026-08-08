import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const profilePath = process.env.OPTO_SYNC_PROFILE;
const NO_SYNC = profilePath
  ? false
  : 'run through the isolated Opto-Sync workflow with OPTO_SYNC_PROFILE set';
const require = createRequire(import.meta.url);

let profile;
let sdk;
if (!NO_SYNC) {
  require('fake-indexeddb/auto');
  profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  sdk = require(process.env.OPTO_SYNC_SDK_ENTRY ?? '../dist/index.js');
}

const {
  OptoSyncClient,
  createOptoSyncClient,
  initOptoSync,
  SYNC_STATUS,
  reconcileIncoming,
  engineVersion,
} = sdk ?? {};

const SHA256 = /^[0-9a-f]{64}$/;
const VCS_COMMIT = /^[0-9a-f]{40}$/;
const FORBIDDEN_PACKAGE_KEYS = new Set([
  'accesstoken',
  'artifactbytes',
  'authorization',
  'locksecret',
  'privatekey',
  'publishcommand',
  'registrycredential',
  'releasetoken',
  'signingkey',
  'sourcearchive',
]);

function normalizeKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function assertPackageMetadataOnly(value, label = 'package metadata') {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertPackageMetadataOnly(entry, `${label}[${index}]`);
    }
    return;
  }
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    assert.equal(
      normalized.includes('refs/heads/main') ||
        normalized.includes('branch = "main"') ||
        normalized === 'latest',
      false,
      `${label} must not contain a mutable source reference`,
    );
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, entry] of Object.entries(value)) {
    assert.equal(
      FORBIDDEN_PACKAGE_KEYS.has(normalizeKey(key)),
      false,
      `${label}.${key} must not contain credentials, commands, or artifact bytes`,
    );
    assertPackageMetadataOnly(entry, `${label}.${key}`);
  }
}

function assertImmutableVersionIdentity(value, label = 'package version') {
  assert.equal(typeof value.organization, 'string', `${label}.organization is required`);
  assert.equal(typeof value.name, 'string', `${label}.name is required`);
  assert.match(value.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, `${label}.version must be explicit SemVer text`);
  assert.match(value.artifactSha256, SHA256, `${label}.artifactSha256 must be lowercase SHA-256`);
  assert.match(value.vcsCommit, VCS_COMMIT, `${label}.vcsCommit must be exact 40-hex`);
  assert.equal(typeof value.vcsTag, 'string', `${label}.vcsTag is required`);
  assert.ok(value.vcsTag.length > 0, `${label}.vcsTag must not be empty`);
  assertPackageMetadataOnly(value, label);
}

function packageIdentity(value) {
  return {
    organization: value.organization,
    name: value.name,
    version: value.version,
    artifactSha256: value.artifactSha256,
    vcsCommit: value.vcsCommit,
    vcsTag: value.vcsTag,
  };
}

async function deleteDatabase(name) {
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

async function openClient(databaseName) {
  if (typeof initOptoSync === 'function') await initOptoSync();
  if (typeof createOptoSyncClient === 'function') {
    return createOptoSyncClient({
      databaseName,
      stampUpdatedAt: false,
    });
  }
  return new OptoSyncClient({
    databaseName,
    stampUpdatedAt: false,
  });
}

test(
  'the downstream profile keeps product policy above the shared engine',
  { skip: NO_SYNC },
  () => {
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
  },
);

test(
  'a product mutation survives restart, keeps its protocol id, and hides a stale server echo',
  { skip: NO_SYNC },
  async (t) => {
    const databaseName =
      `opto-downstream-${profile.repository.replaceAll('/', '-')}`;
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
    const mutationId = await client.queueMutation(
      collection,
      recordId,
      pendingPayload,
    );
    const firstPush = await client.protocolPushRequest();
    const replayedPush = await client.protocolPushRequest();
    assert.deepEqual(
      firstPush.mutations.map((mutation) => mutation.mutationId),
      replayedPush.mutations.map((mutation) => mutation.mutationId),
    );
    client.db.close();

    const reopened = new OptoSyncClient({
      databaseName,
      stampUpdatedAt: false,
    });
    const pendingAfterRestart = await reopened.pendingMutations();
    assert.equal(pendingAfterRestart.length, 1);
    assert.equal(pendingAfterRestart[0].tableName, collection);
    assert.equal(pendingAfterRestart[0].recordId, recordId);
    assert.deepEqual(
      JSON.parse(pendingAfterRestart[0].jsonPayload),
      pendingPayload,
    );

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
  },
);

test(
  'timestamp conflicts and tombstones are deterministic in the installed engine',
  { skip: NO_SYNC },
  async () => {
    if (typeof initOptoSync === 'function') await initOptoSync();

    const local = {
      id: 'conflict-1',
      value: 'new local',
      updatedAt: 200,
    };
    const staleIncoming = {
      id: 'conflict-1',
      value: 'old server',
      updatedAt: 100,
    };
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
    const winner = reconcileIncoming(staleLiveRecord, newerTombstone);
    assert.equal(winner.tombstone, true);
    assert.equal(winner.deletedAt, 200);
    assert.equal(winner.value, null);
    assert.match(String(engineVersion()), /^\d+\.\d+\.\d+/);
  },
);

test(
  'Zed profile matches package-domain collections and preserves bootstrap independence',
  { skip: NO_SYNC },
  () => {
    assert.deepEqual(
      [...profile.collections].sort(),
      [
        'installations',
        'organizations',
        'package_versions',
        'packages',
        'release_channels',
      ],
    );
    assert.ok(profile.persistence.desktop.includes('sqlite'));
    const forbiddenCollections = new Set([
      'access_tokens',
      'artifact_bytes',
      'lockfile_secrets',
      'private_sources',
      'publication_commands',
      'registry_credentials',
      'signing_keys',
      'source_archives',
    ]);
    assert.equal(
      profile.collections.some((collection) =>
        forbiddenCollections.has(collection),
      ),
      false,
    );
    assert.ok(
      profile.domainGuards.some((guard) =>
        guard.includes('CLI and registry bootstrap remain independent'),
      ),
    );
    assert.ok(
      profile.domainGuards.some((guard) =>
        guard.includes('manifest parsing, lock parsing, registry resolution'),
      ),
    );
    assert.ok(
      profile.domainGuards.some((guard) =>
        guard.includes('artifact digest, and lock provenance are immutable'),
      ),
    );

    assert.throws(
      () => assertPackageMetadataOnly({registryCredential: 'not allowed'}),
      /must not contain credentials, commands, or artifact bytes/,
    );
    assert.throws(
      () => assertPackageMetadataOnly({sourceRef: 'refs/heads/main'}),
      /must not contain a mutable source reference/,
    );
  },
);

test(
  'package and package-version mutations sharing an id remain isolated with immutable identity',
  { skip: NO_SYNC },
  async (t) => {
    const databaseName =
      `opto-zed-package-domain-${profile.repository.replaceAll('/', '-')}`;
    const packageId = 'zed-pkg-opto-sync-client';

    await deleteDatabase(databaseName);
    t.after(() => deleteDatabase(databaseName));

    const packageRecord = {
      id: packageId,
      organization: 'opto-sync',
      name: 'opto-sync-clients',
      visibility: 'public',
      defaultReleaseChannel: 'stable',
      updatedAt: 700,
    };
    const versionRecord = {
      id: packageId,
      organization: 'opto-sync',
      name: 'opto-sync-clients',
      version: '0.2.0',
      artifactSha256: 'a'.repeat(64),
      vcsCommit: 'b'.repeat(40),
      vcsTag: 'v0.2.0',
      state: 'candidate',
      installable: false,
      updatedAt: 701,
    };
    assertPackageMetadataOnly(packageRecord, 'package');
    assertImmutableVersionIdentity(versionRecord, 'package version');

    const client = await openClient(databaseName);
    const packageMutationId = await client.queueMutation(
      'packages',
      packageId,
      packageRecord,
    );
    const versionMutationId = await client.queueMutation(
      'package_versions',
      packageId,
      versionRecord,
    );
    assert.notEqual(packageMutationId, versionMutationId);

    const firstPush = await client.protocolPushRequest();
    const replayedPush = await client.protocolPushRequest();
    const projection = (request) =>
      request.mutations.map((mutation) => ({
        mutationId: mutation.mutationId,
        recordId: mutation.recordId,
        table: mutation.table,
      }));
    assert.deepEqual(projection(replayedPush), projection(firstPush));
    assert.deepEqual(
      new Set(firstPush.mutations.map((mutation) => mutation.table)),
      new Set(['packages', 'package_versions']),
    );

    client.db.close();
    const reopened = new OptoSyncClient({
      databaseName,
      stampUpdatedAt: false,
    });
    const afterRestart = await reopened.pendingMutations();
    assert.deepEqual(
      new Set(afterRestart.map((mutation) => mutation.tableName)),
      new Set(['packages', 'package_versions']),
    );
    const queuedVersion = afterRestart.find(
      (mutation) => mutation.tableName === 'package_versions',
    );
    assertImmutableVersionIdentity(
      JSON.parse(queuedVersion.jsonPayload),
      'queued package version',
    );

    await reopened.markMutation(packageMutationId, SYNC_STATUS.SYNCED);
    const remaining = await reopened.pendingMutations();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].tableName, 'package_versions');
    reopened.db.close();
  },
);

test(
  'server-authoritative yank and restore preserve immutable package identity',
  { skip: NO_SYNC },
  async () => {
    if (typeof initOptoSync === 'function') await initOptoSync();

    const stalePublished = {
      id: 'version-0.2.0',
      organization: 'opto-sync',
      name: 'opto-sync-clients',
      version: '0.2.0',
      artifactSha256: 'c'.repeat(64),
      vcsCommit: 'd'.repeat(40),
      vcsTag: 'v0.2.0',
      state: 'published',
      installable: true,
      updatedAt: 400,
    };
    const authoritativeYank = {
      ...stalePublished,
      state: 'yanked',
      installable: false,
      yankedAt: 500,
      updatedAt: 500,
    };
    assertImmutableVersionIdentity(stalePublished, 'published version');
    assertImmutableVersionIdentity(authoritativeYank, 'yanked version');
    assert.deepEqual(
      packageIdentity(authoritativeYank),
      packageIdentity(stalePublished),
    );

    let winner = reconcileIncoming(stalePublished, authoritativeYank);
    assert.equal(winner.state, 'yanked');
    assert.equal(winner.installable, false);
    assert.deepEqual(
      reconcileIncoming(authoritativeYank, {
        ...stalePublished,
        updatedAt: 450,
      }),
      authoritativeYank,
    );

    const authoritativeRestore = {
      ...authoritativeYank,
      state: 'published',
      installable: true,
      restoredAt: 600,
      updatedAt: 600,
    };
    assertImmutableVersionIdentity(authoritativeRestore, 'restored version');
    assert.deepEqual(
      packageIdentity(authoritativeRestore),
      packageIdentity(authoritativeYank),
    );
    winner = reconcileIncoming(authoritativeYank, authoritativeRestore);
    assert.equal(winner.state, 'published');
    assert.equal(winner.installable, true);
    assert.equal(winner.restoredAt, 600);
  },
);
