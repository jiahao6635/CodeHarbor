// Keep this contract aligned with the handlers in server.ts. MCP RPC is described
// at the transport boundary; its tool schemas are provided by tools/list.
import type { StaticDocumentSpec } from '@fastify/swagger';

type OpenApiDocument = Extract<StaticDocumentSpec['document'], { openapi: string }>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const ok = (description: string, schema: object) => ({ description, content: json(schema) });
const request = (schema: object, allowExtra = false) => ({ required: true, content: json(allowExtra ? schema : { ...schema, additionalProperties: false }) });
const error = (description: string) => ok(description, ref('Error'));
const common = {
  '400': error('请求参数、JSON 或 Webhook 内容无效。'),
  '401': error('认证失败、令牌失效，或云效凭据失效。'),
  '403': error('权限不足或 Host / Origin 未被允许。'),
  '404': error('资源不存在或当前身份无权访问。'),
  '413': error('请求体超过 64 KiB。'),
  '415': error('需要 Content-Type: application/json。'),
  '500': error('服务内部错误。'),
  '503': error('云效或授权服务不可用。'),
};
const pathParam = (name: string, description: string) => ({ name, in: 'path', required: true, description, schema: { type: 'string' } });
const object = (properties: object, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const strings = { type: 'array', items: { type: 'string' } };
const scope = { type: 'string', enum: ['read', 'write'], description: 'write 仅允许平台管理和触发索引，不授予代码写入权限。' };
const expiresIn = { type: 'integer', minimum: 60, maximum: 7776000, default: 2592000, description: '有效期，单位秒；默认 30 天，最多 90 天。' };
const repoScope = { ...strings, nullable: true, maxItems: 100, description: 'CodeHarbor 仓库 ID 列表；null 表示所有当前有权访问的仓库。' };
const jobId = object({ job_id: { type: 'string' } }, ['job_id']);

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'CodeHarbor API', version: '0.1.0',
    description: 'CodeHarbor 管理 API 与 MCP 入口。除公开健康检查和云效账号绑定外，管理接口使用 CodeHarbor API Key，而不是云效 PAT。API Key 的 read / write 不改变云效仓库权限。索引任务异步执行，提交成功不代表索引完成。',
  },
  servers: [{ url: '/' }],
  security: [{ ApiKey: [] }],
  tags: [{ name: '认证' }, { name: '云效仓库' }, { name: '仓库与索引' }, { name: 'API Key' }, { name: 'Webhook' }, { name: 'MCP' }, { name: '运维' }],
  paths: {
    '/health/live': { get: { tags: ['运维'], summary: '进程存活检查', security: [], responses: { '200': ok('进程存活。', ref('Health')), '403': common['403'] } } },
    '/health/ready': { get: { tags: ['运维'], summary: '服务就绪检查', description: '检查数据库；工作树模式检查 CodeGraph MCP 工具，镜像模式检查调度控制器，不逐个检查仓库镜像。', security: [], responses: { '200': ok('依赖就绪。', ref('Health')), '403': common['403'], '503': ok('依赖不可用。', ref('Health')) } } },
    '/metrics': { get: { tags: ['运维'], summary: 'Prometheus 指标', description: '需要单独配置的 metrics token；未启用时返回 404。', security: [{ MetricsBearer: [] }], responses: { '200': { description: 'Prometheus 文本格式。', content: { 'text/plain': { schema: { type: 'string' } } } }, '401': common['401'], '403': common['403'], '404': common['404'] } } },
    '/api/v1/auth/yunxiao/bind': { post: { tags: ['认证'], summary: '绑定云效个人访问令牌', description: 'PAT 将加密保存。返回的 bootstrap_token 仅用于创建首个 API Key，5 分钟过期且成功使用后失效；重新绑定会使依赖该账号的自动同步仓库需要重新授权。', security: [], requestBody: request(object({ pat: { type: 'string', minLength: 1, maxLength: 4096, format: 'password' } }, ['pat'])), responses: { '200': ok('绑定成功；bootstrap_token 只在此响应中返回。', ref('BootstrapSession')), ...common, '429': error('绑定请求过于频繁。') } } },
    '/api/v1/auth/bootstrap/keys': { post: { tags: ['认证'], summary: '创建首个 API Key', description: '使用绑定后获得的 bootstrap_token。write 仅允许配置中的用户创建；令牌明文仅在成功响应中返回一次。', security: [{ BootstrapBearer: [] }], requestBody: request(object({ scope, expires_in: expiresIn }, ['scope'])), responses: { '201': ok('密钥创建成功。', ref('BootstrapKey')), ...common } } },
    '/api/v1/me': { get: { tags: ['认证'], summary: '当前身份和密钥权限', responses: { '200': ok('当前身份。', ref('Me')), ...common } } },
    '/api/v1/codeup/repositories': { get: { tags: ['云效仓库'], summary: '列出云效可见仓库', description: '仅无限定仓库范围的 API Key 可调用。可见不等于具有克隆权限；接入仓库时会进一步检查。', parameters: [{ name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 }, description: '页码；每页最多 100 项。' }], responses: { '200': ok('仓库列表。', object({ repositories: { type: 'array', items: ref('CodeupRepository') }, next_page: { type: 'integer', nullable: true } }, ['repositories', 'next_page'])), ...common } } },
    '/api/v1/repositories': {
      get: { tags: ['仓库与索引'], summary: '列出当前密钥可访问的已接入仓库', responses: { '200': ok('仓库列表。', object({ repositories: { type: 'array', items: ref('Repository') } }, ['repositories'])), ...common } },
      post: { tags: ['仓库与索引'], summary: '接入仓库并创建索引任务', description: '需要 write，接入新仓库需要无限定仓库范围的密钥。确认授权后使用已绑定 PAT 自动同步；创建成功后立即保存 webhook_token，后续不会再次返回。若仓库已接入，返回 200 且不再返回 webhook token。', requestBody: request(object({ codeup_repository_id: { description: '云效仓库数字 ID。', oneOf: [{ type: 'string', pattern: '^\\d{1,30}$' }, { type: 'integer', minimum: 0 }] }, branch: { type: 'string', default: 'main', minLength: 1, maxLength: 255 }, authorize_automatic_sync: { type: 'boolean', enum: [true], description: '明确授权使用当前绑定的云效凭据进行自动同步。' } }, ['codeup_repository_id', 'authorize_automatic_sync'])), responses: { '200': ok('该仓库已接入。', object({ repository: ref('Repository') }, ['repository'])), '202': ok('仓库已接入并已创建初始索引任务。', ref('CreatedRepository')), ...common } },
    },
    '/api/v1/repositories/{repoId}': { get: { tags: ['仓库与索引'], summary: '查看仓库状态', parameters: [pathParam('repoId', 'CodeHarbor 仓库 ID')], responses: { '200': ok('仓库状态。', ref('Repository')), ...common } } },
    '/api/v1/repositories/{repoId}/sync': { post: { tags: ['仓库与索引'], summary: '触发索引同步', description: '需要 write；返回任务 ID，可查询任务状态。', parameters: [pathParam('repoId', 'CodeHarbor 仓库 ID')], responses: { '202': ok('已接受任务。', jobId), ...common } } },
    '/api/v1/repositories/{repoId}/sync-credential': { put: { tags: ['仓库与索引'], summary: '重新授权自动同步凭据', description: '需要 write，且调用者是仓库所有者或当前同步凭据所有者；更新授权并触发任务。', parameters: [pathParam('repoId', 'CodeHarbor 仓库 ID')], requestBody: request(object({ authorize_automatic_sync: { type: 'boolean', enum: [true] } }, ['authorize_automatic_sync'])), responses: { '202': ok('已授权并接受任务。', jobId), ...common } } },
    '/api/v1/jobs/{jobId}': { get: { tags: ['仓库与索引'], summary: '查看索引任务', parameters: [pathParam('jobId', '索引任务 ID')], responses: { '200': ok('任务状态。', ref('Job')), ...common } } },
    '/api/v1/api-keys': {
      get: { tags: ['API Key'], summary: '列出当前账号的密钥', description: '限定仓库范围的密钥只返回自身。不会返回密钥明文。', responses: { '200': ok('密钥列表。', object({ keys: { type: 'array', items: ref('KeyInfo') } }, ['keys'])), ...common } },
      post: { tags: ['API Key'], summary: '创建 API Key', description: '需要 write。新密钥的仓库范围不能超过当前密钥，过期时间不能晚于当前密钥；密钥明文仅在成功响应中返回一次。', requestBody: request(object({ scope, repos: repoScope, expires_in: expiresIn }, ['scope'])), responses: { '201': ok('密钥创建成功。', ref('CreatedKey')), ...common } },
    },
    '/api/v1/api-keys/{prefix}': { delete: { tags: ['API Key'], summary: '撤销 API Key', description: '需要 write；限定仓库范围的密钥只能撤销自身。', parameters: [pathParam('prefix', '密钥前缀，如 ch_ 后跟 8 个字符')], responses: { '200': ok('密钥已撤销。', object({ revoked: { type: 'boolean', enum: [true] } }, ['revoked'])), ...common } } },
    '/api/v1/hooks/codeup/{repoId}': { post: { tags: ['Webhook'], summary: '接收云效 Push Hook', description: '使用仓库创建时返回的 webhook_token。Push Hook 项目 ID、分支和提交须匹配；非 Push Hook 或其他分支事件会被忽略但仍返回 202。全零 after 表示分支删除。', security: [{ WebhookToken: [] }], parameters: [pathParam('repoId', 'CodeHarbor 仓库 ID'), { name: 'codeup-event', in: 'header', required: false, schema: { type: 'string' }, description: 'Push 事件应为 Push Hook。' }], requestBody: request(object({ object_kind: { type: 'string', enum: ['push'] }, project_id: { oneOf: [{ type: 'integer' }, { type: 'string' }] }, ref: { type: 'string' }, after: { type: 'string', pattern: '^[0-9a-f]{40,64}$' } }), true), responses: { '202': ok('事件已接受或被忽略。', object({ accepted: { type: 'boolean', enum: [true] } }, ['accepted'])), ...common } } },
    '/mcp': { post: { tags: ['MCP'], summary: 'MCP Streamable HTTP 入口', description: '使用 CodeHarbor API Key，通过 MCP 客户端进行 initialize、tools/list 和 tools/call。请求及响应遵循 MCP / JSON-RPC，工具包括 list_repositories、get_repository_status、codegraph_explore，具体输入结构由 tools/list 提供。read 可查询；write 仍不能修改仓库代码。', requestBody: request({ type: 'object', description: 'MCP JSON-RPC 消息。' }, true), responses: { '200': { description: 'MCP 响应；格式和头部遵循 MCP 协议。' }, '202': { description: 'MCP 通知已接受。' }, '400': { description: 'MCP 协议请求错误。' }, '401': { description: '认证失败；返回 MCP JSON-RPC 错误。' }, '403': common['403'], '405': { description: '不支持的方法。' }, '503': { description: '认证服务不可用；返回 MCP JSON-RPC 错误。' } } } },
  },
  components: {
    securitySchemes: {
      ApiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'CodeHarbor API Key', description: '通过 API Key 管理接口获得；并非云效 PAT。' },
      BootstrapBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'Bootstrap token', description: '绑定云效 PAT 后得到的一次性短期令牌。' },
      MetricsBearer: { type: 'http', scheme: 'bearer', description: '单独配置的 metrics token。' },
      WebhookToken: { type: 'apiKey', in: 'header', name: 'X-Codeup-Token', description: '接入仓库时返回的 webhook_token。' },
    },
    schemas: {
      Error: object({ error: { type: 'string', description: '稳定的错误代码，例如 UNAUTHENTICATED、FORBIDDEN、NOT_FOUND。' } }, ['error']),
      Health: object({ status: { type: 'string', enum: ['ok', 'unavailable'] } }, ['status']),
      BootstrapSession: object({ bootstrap_token: { type: 'string' }, expires_in: { type: 'integer', description: '单位秒。' }, user: object({ id: { type: 'string' }, name: { type: 'string' } }, ['id', 'name']) }, ['bootstrap_token', 'expires_in', 'user']),
      BootstrapKey: object({ token: { type: 'string' }, prefix: { type: 'string' }, scope, expires_in: { type: 'integer', description: '单位秒。' } }, ['token', 'prefix', 'scope', 'expires_in']),
      Me: object({ id: { type: 'string' }, username: { type: 'string' }, key_scope: scope }, ['id', 'username', 'key_scope']),
      CodeupRepository: object({ id: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' }, access_level: { type: 'integer', nullable: true } }, ['id', 'name', 'path', 'access_level']),
      Repository: object({ repo_id: { type: 'string' }, name: { type: 'string' }, branch: { type: 'string' }, status: { type: 'string' }, indexed_commit: { type: 'string', nullable: true }, indexed_at: { type: 'string', format: 'date-time', nullable: true }, stale: { type: 'boolean' }, error: { type: 'string', nullable: true } }, ['repo_id', 'name', 'branch', 'status', 'indexed_commit', 'indexed_at', 'stale', 'error']),
      CreatedRepository: object({ repository: ref('Repository'), job_id: { type: 'string' }, webhook_token: { type: 'string', description: '仅此响应返回，需妥善保存。' }, webhook_path: { type: 'string' } }, ['repository', 'job_id', 'webhook_token', 'webhook_path']),
      Job: object({ id: { type: 'string' }, repo_id: { type: 'string' }, status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed'] }, reason: { type: 'string' }, created_at: { type: 'integer', description: 'Unix 毫秒时间戳。' }, error: { type: 'string', nullable: true } }, ['id', 'repo_id', 'status', 'reason', 'created_at', 'error']),
      KeyInfo: object({ prefix: { type: 'string' }, scope, repos: repoScope, expires_at: { type: 'integer', nullable: true, description: 'Unix 毫秒时间戳。' }, revoked: { type: 'boolean' } }, ['prefix', 'scope', 'repos', 'expires_at', 'revoked']),
      CreatedKey: object({ token: { type: 'string', description: '仅此响应返回，需妥善保存。' }, prefix: { type: 'string' }, scope, repos: repoScope, expires_at: { type: 'integer', description: 'Unix 毫秒时间戳。' } }, ['token', 'prefix', 'scope', 'repos', 'expires_at']),
    },
  },
} as OpenApiDocument;
