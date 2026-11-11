import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileImageCreationFence } from '../src/image-creation-fence.js';

test('image creation fence persists until the matching container is confirmed removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-image-fence-'));
  try {
    const fence = new FileImageCreationFence(dir, 'controller_1');
    const name = `codeharbor-query-${randomUUID()}`;
    await fence.assertClear();
    await fence.begin(name);
    await assert.rejects(new FileImageCreationFence(dir, 'controller_1').assertClear(), /operator intervention/);
    await assert.rejects(fence.begin(name));
    await assert.rejects(fence.complete(`codeharbor-query-${randomUUID()}`), /ownership mismatch/);
    await fence.complete(name);
    await fence.assertClear();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('image creation fence rejects unsafe directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-image-fence-'));
  try {
    await chmod(dir, 0o755);
    await assert.rejects(new FileImageCreationFence(dir, 'controller_1').assertClear(), /Unsafe/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
