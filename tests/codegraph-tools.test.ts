import assert from 'node:assert/strict';
import test from 'node:test';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { assertCodeGraphToolSchema, CODEGRAPH_TOOLS, validCodeGraphToolCall } from '../src/codegraph-tools.js';

const valid = (name: string, args: Record<string, unknown>) => validCodeGraphToolCall({ name, arguments: args });

test('fixed seven-tool contract preserves all v1.6.2 parameters while forbidding project selection', () => {
  assert.equal(CODEGRAPH_TOOLS.length, 7);
  for (const tool of CODEGRAPH_TOOLS) {
    assert.ok(tool.inputSchema.required?.includes('repo_id'));
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(!Object.hasOwn(tool.inputSchema.properties!, 'projectPath'));
    assert.equal(tool.annotations?.readOnlyHint, true);
  }
  for (const args of [
    { symbol: 'alpha' },
    { file: 'src/app.ts' },
    { symbol: 'alpha', file: 'app.ts', line: 1, includeCode: true },
  ]) {
    assert.ok(valid('codegraph_node', args));
  }
  assert.ok(valid('codegraph_node', { file: 'app.ts', offset: 1, limit: 2000, symbolsOnly: true }));
  assert.ok(valid('codegraph_explore', { query: 'alpha', maxFiles: 50 }));
  assert.ok(
    valid('codegraph_files', {
      path: 'src',
      pattern: '**/*.ts',
      format: 'grouped',
      includeMetadata: false,
      maxDepth: 100,
    }),
  );
  assert.ok(valid('codegraph_search', { query: 'alpha', kind: 'type', limit: 100 }));
  assert.ok(valid('codegraph_impact', { symbol: 'alpha', file: 'app.ts', depth: 10 }));
});

test('all trust boundaries reject wrong tools, modes, numeric limits, fields and paths', () => {
  for (const [name, args] of [
    ['codegraph_status', {}],
    ['codegraph_node', {}],
    ['codegraph_search', { query: ' ' }],
    ['codegraph_explore', { query: 'x', maxFiles: 51 }],
    ['codegraph_explore', { query: 'x', maxFiles: 1.5 }],
    ['codegraph_search', { query: 'x', kind: 'unknown' }],
    ['codegraph_search', { query: 'x', limit: 0 }],
    ['codegraph_impact', { symbol: 'x', depth: 11 }],
    ['codegraph_node', { file: 'x', limit: 2001 }],
    ['codegraph_node', { symbol: 'x', includeCode: 'true' }],
    ['codegraph_files', { format: 'json' }],
    ['codegraph_files', { maxDepth: Number.NaN }],
    ['codegraph_files', { includeMetadata: 1 }],
    ['codegraph_explore', { query: 'x', projectPath: '/other' }],
    ['codegraph_files', { repo_id: 'other' }],
    ['codegraph_node', { file: 'app.ts', unknown: true }],
  ] as Array<[string, Record<string, unknown>]>)
    assert.equal(valid(name, args), false, `${name}: ${JSON.stringify(args)}`);
  for (const file of [
    '../secret',
    'src/../../secret',
    '/etc/passwd',
    ' /etc/passwd ',
    '\\server\\share',
    'C:\\secret',
    'src\\..\\secret',
    'secret\0',
    'src\nfile',
  ]) {
    for (const [name, key, base] of [
      ['codegraph_node', 'file', {}],
      ['codegraph_callers', 'file', { symbol: 'x' }],
      ['codegraph_callees', 'file', { symbol: 'x' }],
      ['codegraph_impact', 'file', { symbol: 'x' }],
      ['codegraph_files', 'path', {}],
      ['codegraph_files', 'pattern', {}],
    ] as Array<[string, string, Record<string, unknown>]>)
      assert.equal(valid(name, { ...base, [key]: file }), false, `${name}: ${file}`);
  }
  assert.equal(validCodeGraphToolCall(null), false);
  assert.equal(validCodeGraphToolCall({ name: 'codegraph_files', arguments: [], extra: true }), false);
});

test('upstream compatibility checks type, enums and required parameters before calling', () => {
  const upstream = CODEGRAPH_TOOLS.map((tool) => ({
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: Object.fromEntries([
        ['projectPath', { type: 'string' }],
        ...Object.entries(tool.inputSchema.properties!)
          .filter(([key]) => key !== 'repo_id')
          .map(([key, value]) => {
            const property = value as { type: string };
            return [key, { ...property, type: property.type === 'integer' ? 'number' : property.type }];
          }),
      ]),
      required: tool.inputSchema.required?.filter((key) => key !== 'repo_id'),
    },
  })) as Tool[];
  for (const tool of upstream)
    assert.doesNotThrow(() =>
      assertCodeGraphToolSchema(upstream, { name: tool.name as 'codegraph_files', arguments: {} }),
    );
  assert.throws(() => assertCodeGraphToolSchema([], { name: 'codegraph_files', arguments: {} }), /Incompatible/);
  const files = upstream.find((tool) => tool.name === 'codegraph_files')!;
  const incompatible = structuredClone(files);
  delete incompatible.inputSchema.properties!.pattern;
  assert.throws(
    () => assertCodeGraphToolSchema([incompatible], { name: 'codegraph_files', arguments: {} }),
    /Incompatible/,
  );
  const wrongEnum = structuredClone(files);
  wrongEnum.inputSchema.properties!.format = { type: 'string', enum: ['tree'] };
  assert.throws(
    () => assertCodeGraphToolSchema([wrongEnum], { name: 'codegraph_files', arguments: {} }),
    /Incompatible/,
  );
});
