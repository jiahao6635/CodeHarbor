import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const baseImage = process.env.CODEHARBOR_READONLY_TEST_IMAGE;
test('real CodeGraph MCP reads a sealed index with a read-only root and no mounts', {
  skip: !baseImage && 'Set CODEHARBOR_READONLY_TEST_IMAGE to the built readonly CodeGraph image',
  timeout: 180_000,
}, async () => {
  assert.match(baseImage, /^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254})$/);
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-readonly-test-'));
  const name = `codeharbor-ro-test-${randomUUID()}`;
  const image = `codeharbor-ro-test:${randomUUID()}`;
  const docker = (...args) =>
    execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  let client;
  try {
    await writeFile(
      join(dir, 'example.py'),
      'def magnolia_readonly_probe():\n    return "orchid-readonly-ok"\n\ndef orchid_caller():\n    return magnolia_readonly_probe()\n',
    );
    await writeFile(
      join(dir, 'Dockerfile'),
      `${[
        `FROM ${baseImage}`,
        'COPY --chown=node:node example.py /workspace/repo/example.py',
        'RUN node /readonly-codegraph/dist/bin/codegraph.js init /workspace/repo --yes',
        'RUN node /readonly-codegraph/seal-index.cjs /workspace/repo',
      ].join('\n')}\n`,
    );
    const platform = docker('image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', baseImage).trim();
    assert.match(platform, /^linux\/(?:amd64|arm64)$/);
    docker('build', '--platform', platform, '-t', image, dir);
    const transport = new StdioClientTransport({
      command: 'docker',
      args: [
        'run',
        '-i',
        '--platform',
        platform,
        '--name',
        name,
        '--read-only',
        '--network',
        'none',
        '--user',
        '1000:1000',
        image,
      ],
      stderr: 'pipe',
    });
    client = new Client({ name: 'codeharbor-readonly-test', version: '1' });
    await client.connect(transport, { timeout: 30_000 });
    const { tools } = await client.listTools(undefined, { timeout: 30_000 });
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        'codegraph_search',
        'codegraph_callers',
        'codegraph_callees',
        'codegraph_impact',
        'codegraph_node',
        'codegraph_explore',
        'codegraph_files',
      ].sort(),
    );
    const result = await client.callTool(
      {
        name: 'codegraph_explore',
        arguments: {
          projectPath: '/workspace/repo',
          query: 'magnolia_readonly_probe',
        },
      },
      undefined,
      { timeout: 30_000 },
    );
    assert.notEqual(result.isError, true);
    assert.match(JSON.stringify(result.content), /magnolia_readonly_probe/);
    for (const [name, args, expected] of [
      ['codegraph_search', { query: 'magnolia', kind: 'function', limit: 3 }, /magnolia_readonly_probe/],
      ['codegraph_callers', { symbol: 'magnolia_readonly_probe', file: 'example.py', limit: 3 }, /orchid_caller/],
      ['codegraph_callees', { symbol: 'orchid_caller', file: 'example.py', limit: 3 }, /magnolia_readonly_probe/],
      ['codegraph_impact', { symbol: 'magnolia_readonly_probe', file: 'example.py', depth: 2 }, /orchid_caller/],
      [
        'codegraph_node',
        { symbol: 'magnolia_readonly_probe', file: 'example.py', line: 1, includeCode: true },
        /orchid-readonly-ok/,
      ],
      ['codegraph_node', { file: 'example.py', offset: 2, limit: 1 }, /2\t.*orchid-readonly-ok/],
      ['codegraph_node', { file: 'example.py', symbolsOnly: true }, /magnolia_readonly_probe/],
      ['codegraph_explore', { query: 'magnolia_readonly_probe', maxFiles: 1 }, /orchid-readonly-ok/],
      ['codegraph_files', { pattern: '*.py', format: 'flat', includeMetadata: true, maxDepth: 3 }, /example.py/],
    ]) {
      const response = await client.callTool(
        { name, arguments: { ...args, projectPath: '/workspace/repo' } },
        undefined,
        { timeout: 30_000 },
      );
      assert.notEqual(response.isError, true, `${name}: ${JSON.stringify(response)}`);
      assert.match(response.content.map((part) => part.text).join('\n'), expected, name);
    }
    await client.close();
    client = undefined;
    docker('wait', name);
    const state = JSON.parse(docker('inspect', name))[0];
    assert.equal(state.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(state.Mounts, []);
    assert.equal(docker('diff', name).trim(), '');
  } finally {
    await client?.close().catch(() => {});
    try {
      docker('rm', '-f', name);
    } catch {
      /* Container may not have started. */
    }
    try {
      docker('image', 'rm', image);
    } catch {
      /* Build may have failed. */
    }
    await rm(dir, { recursive: true, force: true });
  }
});
