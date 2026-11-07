import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncSqliteStore } from '../src/async-store.js';

void test('async SQLite store serializes concurrent operations around transactions and rolls back', async () => {
  const store = new AsyncSqliteStore(':memory:');
  try {
    await store.createUser({ id: 'u1', username: 'initial', credential: 'encrypted', credential_version: 1 });
    let ready!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const tx = store.transaction(async t => {
      await t.updateUserCredential('u1', 'updated', 'new-encrypted');
      ready(); await blocked;
    });
    await started;
    let returned = false;
    const read = store.getUser('u1').then(value => { returned = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(returned, false);
    release(); await tx;
    assert.equal((await read)?.username, 'updated');
    await assert.rejects(store.transaction(async t => {
      await t.updateUserCredential('u1', 'rolled-back', 'bad');
      throw new Error('abort');
    }), /abort/);
    assert.equal((await store.getUser('u1'))?.username, 'updated');
    await store.checkHealth();
  } finally { await store.close(); }
});
