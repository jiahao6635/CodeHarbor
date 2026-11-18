import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { CodeGraphClient } from '../src/codegraph.js';
import type { CodeGraphToolCall } from '../src/codegraph-tools.js';

const bin = resolve(process.env.CODEGRAPH_TEST_BIN ?? './node_modules/.bin/codegraph');
const run = promisify(execFile);

test('real CodeGraph queries two independent indexes and switches the published version after draining', {
  skip: !existsSync(bin),
  timeout: 60_000,
}, async () => {
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
      await writeFile(
        join(path, 'app.py'),
        `def ${name}():\n    return "${marker}"\n\ndef entrypoint():\n    return ${name}()\n`,
      );
      await run(bin, ['init', path, '--yes'], {
        env: { ...process.env, DO_NOT_TRACK: '1', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_WATCH: '1' },
        timeout: 20_000,
      });
    }
    await graph.probe();
    const alpha = await graph.withQuery((explore) => explore(paths[0], 'alpha_symbol'));
    const beta = await graph.withQuery((explore) => explore(paths[1], 'beta_symbol'));
    assert.match(alpha, /ALPHA_OLD/);
    assert.doesNotMatch(alpha, /BETA_ONLY|ALPHA_NEW/);
    assert.match(beta, /BETA_ONLY/);
    assert.doesNotMatch(beta, /ALPHA_OLD|ALPHA_NEW/);
    assert.doesNotMatch(alpha, new RegExp(root));

    const calls: Array<[CodeGraphToolCall, RegExp]> = [
      [{ name: 'codegraph_search', arguments: { query: 'alpha_symbol', kind: 'function', limit: 3 } }, /alpha_symbol/],
      [{ name: 'codegraph_callers', arguments: { symbol: 'alpha_symbol', file: 'app.py', limit: 3 } }, /entrypoint/],
      [{ name: 'codegraph_callees', arguments: { symbol: 'entrypoint', file: 'app.py', limit: 3 } }, /alpha_symbol/],
      [{ name: 'codegraph_impact', arguments: { symbol: 'alpha_symbol', file: 'app.py', depth: 2 } }, /entrypoint/],
      [
        { name: 'codegraph_node', arguments: { symbol: 'alpha_symbol', includeCode: true, file: 'app.py', line: 1 } },
        /ALPHA_OLD/,
      ],
      [{ name: 'codegraph_node', arguments: { file: 'app.py', offset: 2, limit: 1 } }, /2\t.*ALPHA_OLD/],
      [{ name: 'codegraph_node', arguments: { file: 'app.py', symbolsOnly: true } }, /alpha_symbol/],
      [{ name: 'codegraph_explore', arguments: { query: 'alpha_symbol', maxFiles: 1 } }, /ALPHA_OLD/],
      [
        { name: 'codegraph_files', arguments: { pattern: '*.py', format: 'flat', includeMetadata: true, maxDepth: 3 } },
        /app.py/,
      ],
    ];
    for (const [call, expected] of calls) {
      const result = await graph.withToolQuery((callTool) => callTool(paths[0], call));
      assert.match(result, expected, call.name);
      assert.doesNotMatch(result, /BETA_ONLY|ALPHA_NEW/);
      assert.ok(!result.includes(root));
    }
    await assert.rejects(
      graph.withToolQuery((callTool) =>
        callTool(paths[0], {
          name: 'codegraph_node',
          arguments: { file: '../beta-v1/app.py' },
        }),
      ),
      /Invalid/,
    );

    let currentPath = paths[0];
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = graph.withQuery(async (explore) => {
      started();
      await blocked;
      return explore(currentPath, 'alpha_symbol');
    });
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

test('closing a CodeGraph transport kills a stubborn descendant in its process group', {
  skip: process.platform === 'win32',
  timeout: 10_000,
}, async () => {
  const { ManagedCodeGraphTransport } = await import('../src/codegraph.js');
  const { chmod, readFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'codeharbor-group-'));
  const executable = join(root, 'fake-codegraph');
  const pidPath = join(root, 'descendant.pid');
  await writeFile(
    executable,
    `#!/usr/bin/env node\nconst {spawn} = require('node:child_process');\nconst fs = require('node:fs');\nconst child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {stdio:'inherit'});\nfs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));\nprocess.on('SIGTERM',()=>{}); setInterval(()=>{},1000);\n`,
  );
  await chmod(executable, 0o700);
  const transport = new ManagedCodeGraphTransport(executable, root);
  transport.onerror = () => {};
  let pid = 0;
  try {
    await transport.start();
    const end = Date.now() + 3000;
    while (!existsSync(pidPath) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    pid = Number(await readFile(pidPath, 'utf8'));
    assert.ok(pid > 0);
    await transport.close();
    // On Linux a killed reparented process may linger as a zombie; that state has no open handles.
    let alive = true;
    try {
      process.kill(pid, 0);
      const result = await run('ps', ['-o', 'stat=', '-p', String(pid)]).catch(() => ({ stdout: '' }));
      alive = !!result.stdout.trim() && !result.stdout.trim().startsWith('Z');
    } catch {
      alive = false;
    }
    assert.equal(alive, false, 'descendant must not continue running after close');
  } finally {
    await transport.close().catch(() => {});
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('closing transport also kills descendants after an early parent exit', {
  skip: process.platform === 'win32',
  timeout: 10_000,
}, async () => {
  const { ManagedCodeGraphTransport } = await import('../src/codegraph.js');
  const { chmod, readFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'codeharbor-orphan-'));
  const executable = join(root, 'fake-codegraph');
  const pidPath = join(root, 'descendant.pid');
  await writeFile(
    executable,
    `#!/usr/bin/env node\nconst {spawn} = require('node:child_process');\nconst fs = require('node:fs');\nconst child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {stdio:'ignore'});\nfs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid)); child.unref();\n`,
  );
  await chmod(executable, 0o700);
  const transport = new ManagedCodeGraphTransport(executable, root);
  transport.onerror = () => {};
  let pid = 0;
  try {
    await transport.start();
    const end = Date.now() + 3000;
    while (!existsSync(pidPath) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    pid = Number(await readFile(pidPath, 'utf8'));
    await new Promise((r) => setTimeout(r, 100));
    await transport.close();
    let alive = true;
    try {
      process.kill(pid, 0);
      const result = await run('ps', ['-o', 'stat=', '-p', String(pid)]).catch(() => ({ stdout: '' }));
      alive = !!result.stdout.trim() && !result.stdout.trim().startsWith('Z');
    } catch {
      alive = false;
    }
    assert.equal(alive, false, 'orphan must not continue running after close');
  } finally {
    await transport.close().catch(() => {});
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});
