import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/** Pinned to CodeGraph v1.6.2; projectPath is exclusively supplied by the gateway. */
export const CODEGRAPH_TOOL_NAMES = [
  'codegraph_search',
  'codegraph_callers',
  'codegraph_callees',
  'codegraph_impact',
  'codegraph_node',
  'codegraph_explore',
  'codegraph_files',
] as const;
export type CodeGraphToolName = (typeof CODEGRAPH_TOOL_NAMES)[number];
export type CodeGraphToolCall = { name: CodeGraphToolName; arguments: Record<string, unknown> };
export type GraphToolQuery = (
  path: string,
  call: CodeGraphToolCall,
  signal?: AbortSignal,
  identity?: { repoId: string; commit: string },
) => Promise<string>;
export const CODEGRAPH_MCP_TOOLS = CODEGRAPH_TOOL_NAMES.map((name) => name.slice('codegraph_'.length)).join(',');

const text = (description: string, maxLength = 2000) => ({ type: 'string', description, minLength: 1, maxLength });
const integer = (description: string, maximum: number, defaultValue?: number) => ({
  type: 'integer',
  description,
  minimum: 1,
  maximum,
  ...(defaultValue === undefined ? {} : { default: defaultValue }),
});
const file = text(
  'Repository-relative file path or basename; narrows same-named definitions. Absolute paths and parent traversal are forbidden.',
  4096,
);
const symbol = text('Name of the function, method, class or other symbol.');
const limit = integer('Maximum number of results (default: 20).', 100, 20);
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const definition = (
  name: CodeGraphToolName,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): Tool => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties: { repo_id: text('Authorized CodeHarbor repository ID.', 128), ...properties },
    required: ['repo_id', ...required],
    additionalProperties: false,
    ...(name === 'codegraph_node' ? { anyOf: [{ required: ['symbol'] }, { required: ['file'] }] } : {}),
  },
  annotations,
});

export const CODEGRAPH_TOOLS: Tool[] = [
  definition(
    'codegraph_search',
    'Quick symbol search by name. Returns locations only (no code). Use codegraph_explore instead to get the actual source / understand an area in one call.',
    {
      query: text('Symbol name or partial name (e.g. auth, signIn, UserService).'),
      kind: {
        type: 'string',
        description: 'Filter by node kind.',
        enum: ['function', 'method', 'class', 'interface', 'type', 'variable', 'route', 'component'],
      },
      limit: integer('Maximum results (default: 10).', 100, 10),
    },
    ['query'],
  ),
  definition(
    'codegraph_callers',
    'List functions that call <symbol>. For the full flow, use codegraph_explore.',
    { symbol, file, limit },
    ['symbol'],
  ),
  definition(
    'codegraph_callees',
    'List functions that <symbol> calls. For the full flow, use codegraph_explore.',
    { symbol, file, limit },
    ['symbol'],
  ),
  definition(
    'codegraph_impact',
    'List symbols affected by changing <symbol>. Use before a refactor.',
    {
      symbol,
      file,
      depth: integer('Dependency traversal depth (default: 2).', 10, 2),
    },
    ['symbol'],
  ),
  definition(
    'codegraph_node',
    'Two modes: pass file without symbol to read indexed-revision source with line numbers and dependents (offset/limit, symbolsOnly supported); pass symbol for location, signature and caller/callee trail, plus verbatim source when includeCode=true. Use file/line to disambiguate. Source is from the published repository revision, not your local working copy. Use codegraph_explore for several related symbols or a full flow.',
    {
      symbol,
      file,
      includeCode: { type: 'boolean', description: 'Include symbol body (symbol mode).', default: false },
      offset: integer('File mode: 1-based starting line.', 10_000_000),
      limit: integer('File mode: maximum lines (default: whole file, capped at 2000).', 2000),
      symbolsOnly: { type: 'boolean', description: 'File mode: symbol map and dependents only.', default: false },
      line: integer('Symbol mode: definition line for disambiguation.', 10_000_000),
    },
  ),
  {
    ...definition(
      'codegraph_explore',
      'PRIMARY TOOL — call FIRST for almost any question: how does X work, architecture, a bug, where/what is X, surveying an area or change impact. Returns relevant verbatim source grouped by file plus the call path in one capped call. Query can be a natural-language question or symbol/file names.',
      {
        query: text('Symbol names, file names or short code terms (e.g. AuthService loginUser session-manager).'),
        maxFiles: integer('Maximum files to include source from (default: 12).', 50, 12),
      },
      ['query'],
    ),
    _meta: { 'anthropic/alwaysLoad': true },
  },
  definition(
    'codegraph_files',
    'Indexed file tree with language + symbol counts. Faster than Glob for project layout.',
    {
      path: text('Filter to this repository-relative directory (e.g. src/components).', 4096),
      pattern: text('Filter by glob pattern (e.g. *.tsx, **/*.test.ts).', 4096),
      format: { type: 'string', description: 'Output format.', enum: ['tree', 'flat', 'grouped'], default: 'tree' },
      includeMetadata: { type: 'boolean', description: 'Include language and symbol counts.', default: true },
      maxDepth: integer('Maximum directory depth; omitted means unlimited.', 100),
    },
  ),
];

export function isCodeGraphToolName(name: unknown): name is CodeGraphToolName {
  return typeof name === 'string' && CODEGRAPH_TOOL_NAMES.some((entry) => entry === name);
}

function safeRelativePath(value: string): boolean {
  const path = value.trim().replace(/\\/g, '/');
  return (
    !path.startsWith('/') &&
    !/^[A-Za-z]:/.test(path) &&
    !path.split('/').includes('..') &&
    Array.from(value).every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
  );
}

function validProperty(key: string, value: unknown, property: Record<string, unknown>): boolean {
  if (Array.isArray(property.enum) && !property.enum.includes(value)) return false;
  if (property.type === 'string') {
    return (
      typeof value === 'string' &&
      !!value.trim() &&
      value.length <= Number(property.maxLength ?? 4096) &&
      !value.includes('\0') &&
      (!['file', 'path', 'pattern'].includes(key) || safeRelativePath(value))
    );
  }
  if (property.type === 'integer') {
    return (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= Number(property.minimum) &&
      value <= Number(property.maximum)
    );
  }
  return property.type === 'boolean' && typeof value === 'boolean';
}

/** Shared validation at every IPC trust boundary; never forward unlisted arguments. */
export function validCodeGraphToolCall(value: unknown): value is CodeGraphToolCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const call = value as Record<string, unknown>;
  if (
    Object.keys(call).length !== 2 ||
    !Object.hasOwn(call, 'name') ||
    !Object.hasOwn(call, 'arguments') ||
    !isCodeGraphToolName(call.name)
  )
    return false;
  const args = call.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const row = args as Record<string, unknown>;
  const schema = CODEGRAPH_TOOLS.find((tool) => tool.name === call.name)?.inputSchema;
  if (!schema) return false;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  if (Object.keys(row).some((key) => key === 'repo_id' || key === 'projectPath' || !Object.hasOwn(properties, key)))
    return false;
  if (schema.required?.some((key) => key !== 'repo_id' && !Object.hasOwn(row, key))) return false;
  if (call.name === 'codegraph_node' && row.symbol === undefined && row.file === undefined) return false;
  return Object.entries(row).every(([key, value]) => validProperty(key, value, properties[key]));
}

/** Validate the requested tool against observed upstream schema, not guesses. */
export function assertCodeGraphToolSchema(tools: Tool[], call: CodeGraphToolCall): void {
  const upstream = tools.find((tool) => tool.name === call.name);
  const expected = CODEGRAPH_TOOLS.find((tool) => tool.name === call.name);
  const properties = upstream?.inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!upstream || !expected || !properties || properties.projectPath?.type !== 'string')
    throw new Error('Incompatible CodeGraph MCP tool schema');
  for (const [key, property] of Object.entries(expected.inputSchema.properties ?? {})) {
    if (key === 'repo_id') continue;
    const expectedType = (property as { type: string }).type;
    const actual = properties[key];
    if (!actual || actual.type !== (expectedType === 'integer' ? 'number' : expectedType))
      throw new Error('Incompatible CodeGraph MCP tool schema');
    const choices = (property as { enum?: unknown[] }).enum;
    if (
      choices &&
      (!Array.isArray(actual.enum) || choices.some((choice) => !(actual.enum as unknown[]).includes(choice)))
    )
      throw new Error('Incompatible CodeGraph MCP tool schema');
  }
  const required = upstream.inputSchema.required ?? [];
  if (required.some((key) => key !== 'projectPath' && !expected.inputSchema.required?.includes(key)))
    throw new Error('Incompatible CodeGraph MCP tool schema');
}
