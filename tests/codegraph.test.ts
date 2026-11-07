import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CodeGraphClient } from '../src/codegraph.js';

const bin = resolve(process.env.CODEGRAPH_TEST_BIN ?? './node_modules/.bin/codegraph');
const run = promisify(execFile);

test('real CodeGraph queries two independent indexes and switches the published version after draining', { skip: !existsSync(bin), timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codeharbor-codegraph-'));
  const workspace = join(root, 'runtime');
  await mkdir(workspace);
  const paths = ['alpha-v1', 'beta-v1', 'alpha-v2'].map((name) => join(root, name));
  const graph = new CodeGraphClient(bin, workspace, 15_000);
  try {
    for (const [i, path] of paths.entries()) {
      await mkdir(path);
      const name = i === 1 ? 'beta_symbol' : 'alpha_symbol';
      const marker = ['ALPHA_OLD', 'BETA_ONLY', 'ALPHA_NEW'][i];
      await writeFile(join(path, 'app.py'), `def ${name}():\n    return "${marker}"\n`);
      await run(bin, ['init', path, '--yes'], { env: { ...process.env, DO_NOT_TRACK: '1', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_WATCH: '1' }, timeout: 20_000 });
    }
    await graph.probe();
    const alpha = await graph.withQuery((explore) => explore(paths[0], 'alpha_symbol'));
    const beta = await graph.withQuery((explore) => explore(paths[1], 'beta_symbol'));
    assert.match(alpha, /ALPHA_OLD/);
    assert.doesNotMatch(alpha, /BETA_ONLY|ALPHA_NEW/);
    assert.match(beta, /BETA_ONLY/);
    assert.doesNotMatch(beta, /ALPHA_OLD|ALPHA_NEW/);
    assert.doesNotMatch(alpha, new RegExp(root));

    let currentPath = paths[0];
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const first = graph.withQuery(async (explore) => { started(); await blocked; return explore(currentPath, 'alpha_symbol'); });
    await entered;
    const publish = graph.withExclusive(async (explore) => {
      assert.match(await explore(paths[2], 'alpha_symbol'), /ALPHA_NEW/);
      currentPath = paths[2];
    });
    const second = graph.withQuery((explore) => explore(currentPath, 'alpha_symbol'));
    release();
    assert.match(await first, /ALPHA_OLD/);
    await publish;
    assert.match(await second, /ALPHA_NEW/);
  } finally {
    await graph.close();
    await rm(root, { recursive: true, force: true });
  }
});
