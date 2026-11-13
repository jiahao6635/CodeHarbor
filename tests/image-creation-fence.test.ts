import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileImageCreationFence } from '../src/image-creation-fence.js';

test('image creation fences track concurrent containers independently until each is removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-image-fence-'));
  try {
    const fence = new FileImageCreationFence(dir, 'controller_1');
    const first = `codeharbor-query-${randomUUID()}`;
    const second = `codeharbor-query-${randomUUID()}`;
    await fence.assertClear();
    await Promise.all([fence.begin(first), fence.begin(second)]);
    await assert.rejects(new FileImageCreationFence(dir, 'controller_1').assertClear(), /operator intervention/);
    await assert.rejects(fence.begin(first));
    await assert.rejects(fence.complete(`codeharbor-query-${randomUUID()}`), /ownership mismatch/);
    await fence.complete(first);
    await assert.rejects(new FileImageCreationFence(dir, 'controller_1').assertClear(), /operator intervention/);
    await fence.complete(second);
    await fence.assertClear();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('legacy and malformed controller markers remain fail closed after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-image-fence-'));
  try {
    const name = `codeharbor-query-${randomUUID()}`;
    const legacy = join(dir, 'controller_1.pending.json');
    await writeFile(legacy, JSON.stringify({version:1, controllerId:'controller_1', containerName:name}), {mode:0o600});
    const fence = new FileImageCreationFence(dir, 'controller_1');
    await assert.rejects(fence.assertClear(), /operator intervention/);
    await assert.rejects(fence.complete(name), /ownership mismatch/);
    assert.ok((await lstat(legacy)).isFile());
    // Even an invalid file matching the controller namespace must block recovery.
    const malformed = join(dir, 'controller_2.pending.invalid');
    await writeFile(malformed, 'broken', {mode:0o600});
    await assert.rejects(new FileImageCreationFence(dir, 'controller_2').assertClear(), /operator intervention/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('markers cannot be completed by another controller or through forged files and links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-image-fence-'));
  try {
    const first = new FileImageCreationFence(dir, 'controller_1');
    const other = new FileImageCreationFence(dir, 'controller_1-other');
    const owned = `codeharbor-query-${randomUUID()}`;
    const forged = `codeharbor-query-${randomUUID()}`;
    const linked = `codeharbor-query-${randomUUID()}`;
    await other.begin(owned);
    await first.assertClear(); // A distinct controller namespace must not block this controller.
    await assert.rejects(first.complete(owned), /ownership mismatch/);
    const target = join(dir, 'target');
    const forgedPath = join(dir, `controller_1.pending.${forged}.json`);
    const linkedPath = join(dir, `controller_1.pending.${linked}.json`);
    await writeFile(forgedPath, JSON.stringify({version:1, controllerId:'controller_1-other', containerName:forged}), {mode:0o600});
    await assert.rejects(first.complete(forged), /ownership mismatch/);
    assert.ok((await lstat(forgedPath)).isFile());
    await writeFile(target, 'do not delete', {mode:0o600});
    await symlink(target, linkedPath);
    await assert.rejects(first.complete(linked));
    assert.ok((await lstat(linkedPath)).isSymbolicLink());
    assert.equal(await readFile(target, 'utf8'), 'do not delete');
    await assert.rejects(first.assertClear(), /operator intervention/);
    await other.complete(owned);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('image creation fence rejects unsafe directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-image-fence-'));
  try {
    await chmod(dir, 0o755);
    await assert.rejects(new FileImageCreationFence(dir, 'controller_1').assertClear(), /Unsafe/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
