// Keep this contract aligned with the handlers in src/routes/*. MCP RPC is described
// at the transport boundary; its tool schemas are provided by tools/list.
import type { StaticDocumentSpec } from '@fastify/swagger';

type OpenApiDocument = Extract<StaticDocumentSpec['document'], { openapi: string }>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const ok = (description: string, schema: object) => ({ description, content: json(schema) });
const request = (schema: object, allowExtra = false) => ({
  required: true,
  content: json(allowExtra ? schema : { ...schema, additionalProperties: false }),
});
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
const pathParam = (name: string, description: string) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string' },
});
const object = (properties: object, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});
const strings = { type: 'array', items: { type: 'string' } };
const scope = {
  type: 'string',
  enum: ['read', 'write'],
  description: 'write 仅允许平台管理和触发索引，不授予代码写入权限。',
};
const expiresIn = {
  type: 'integer',
  nullable: true,
  minimum: 60,
  maximum: 7776000,
  default: 2592000,
  description: '有效期，单位秒；省略时默认 30 天，有限期限最多 90 天；显式 null 表示无限期（无截止日期），仍可撤销。',
};
const repoScope = {
  ...strings,
  nullable: true,
  maxItems: 100,
  description:
    'CodeHarbor 仓库 ID 列表；MCP 代码查询要求列表明确包含仓库 ID。null 不能直接查询代码，仅受配置允许的 write 管理员可用于平台管理。',
};
const jobId = object({ job_id: { type: 'string' } }, ['job_id']);

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'CodeHarbor API',
    version: '0.1.0',
    description:
      'CodeHarbor 管理 API 与 MCP 入口。管理接口使用 CodeHarbor API Key。明确仓库列表的 Key 按列表授权；自助申请的无范围 read Key 按持有者当前云效仓库权限授权（按需核验并缓存，默认 6 小时复核；PAT 失效会自动撤销该用户全部 Key）。云效 PAT 仍用于仓库接入和同步。索引任务异步执行，提交成功不代表索引完成。管理员（配置中的 write 用户）可禁用/删除仓库、撤销任意 Key、查看审计。',
  },
  servers: [{ url: '/' }],
  security: [{ ApiKey: [] }],
  tags: [
    { name: '认证' },
    { name: '云效仓库' },
    { name: '仓库与索引' },
    { name: 'API Key' },
    { name: 'Webhook' },
    { name: 'MCP' },
    { name: '管理' },
    { name: '运维' },
  ],
  paths: {
    '/health/live': {
      get: {
        tags: ['运维'],
        summary: '进程存活检查',
        security: [],
        responses: { '200': ok('进程存活。', ref('Health')), '403': common['403'] },
      },
    },
    '/health/ready': {
      get: {
        tags: ['运维'],
        summary: '服务就绪检查',
        description: '检查数据库；工作树模式检查 CodeGraph MCP 工具，镜像模式检查调度控制器，不逐个检查仓库镜像。',
        security: [],
        responses: {
          '200': ok('依赖就绪。', ref('Health')),
          '403': common['403'],
          '503': ok('依赖不可用。', ref('Health')),
        },
      },
    },
    '/metrics': {
      get: {
        tags: ['运维'],
        summary: 'Prometheus 指标',
        description: '需要单独配置的 metrics token；未启用时返回 404。',
        security: [{ MetricsBearer: [] }],
        responses: {
          '200': { description: 'Prometheus 文本格式。', content: { 'text/plain': { schema: { type: 'string' } } } },
          '401': common['401'],
          '403': common['403'],
          '404': common['404'],
        },
      },
    },
    '/api/v1/auth/yunxiao/bind': {
      post: {
        tags: ['认证'],
        summary: '绑定云效个人访问令牌',
        description:
          'PAT 将加密保存。返回的 bootstrap_token 仅用于创建首个 API Key，5 分钟过期且成功使用后失效；重新绑定会使依赖该账号的自动同步仓库需要重新授权。',
        security: [],
        requestBody: request(
          object({ pat: { type: 'string', minLength: 1, maxLength: 4096, format: 'password' } }, ['pat']),
        ),
        responses: {
          '200': ok('绑定成功；bootstrap_token 只在此响应中返回。', ref('BootstrapSession')),
          ...common,
          '429': error('绑定请求过于频繁。'),
        },
      },
    },
    '/api/v1/auth/bootstrap/keys': {
      post: {
        tags: ['认证'],
        summary: '创建首个 API Key',
        description:
          '使用绑定后获得的 bootstrap_token。read Key 无明确仓库范围，可通过 MCP 查询持有者在云效中具有权限的已接入仓库（按需核验并缓存）；write 仅允许配置中的管理员创建并用于平台管理，管理员可再签发明确仓库范围的 Key。普通 read 初始 Key 无法自己派生 Key。令牌明文仅在成功响应中返回一次。',
        security: [{ BootstrapBearer: [] }],
        requestBody: request(object({ scope, expires_in: expiresIn }, ['scope'])),
        responses: { '201': ok('密钥创建成功。', ref('BootstrapKey')), ...common },
      },
    },
    '/api/v1/me': {
      get: {
        tags: ['认证'],
        summary: '当前身份和密钥权限',
        responses: { '200': ok('当前身份。', ref('Me')), ...common },
      },
    },
    '/api/v1/codeup/repositories': {
      get: {
        tags: ['云效仓库'],
        summary: '列出云效可见仓库',
        description: '仅无限定仓库范围的 API Key 可调用。可见不等于具有克隆权限；接入仓库时会进一步检查。',
        parameters: [
          {
            name: 'page',
            in: 'query',
            schema: { type: 'integer', minimum: 1, default: 1 },
            description: '页码；每页最多 100 项。',
          },
        ],
        responses: {
          '200': ok(
            '仓库列表。',
            object(
              {
                repositories: { type: 'array', items: ref('CodeupRepository') },
                next_page: { type: 'integer', nullable: true },
              },
              ['repositories', 'next_page'],
            ),
          ),
          ...common,
        },
      },
    },
    '/api/v1/repositories': {
      get: {
        tags: ['仓库与索引'],
        summary: '列出当前密钥可访问的已接入仓库',
        responses: {
          '200': ok(
            '仓库列表。',
            object({ repositories: { type: 'array', items: ref('Repository') } }, ['repositories']),
          ),
          ...common,
        },
      },
      post: {
        tags: ['仓库与索引'],
        summary: '接入仓库并创建索引任务',
        description:
          '需要 write，接入新仓库需要无限定仓库范围的密钥。确认授权后使用已绑定 PAT 自动同步；创建成功后立即保存 webhook_token，后续不会再次返回。若仓库已接入，返回 200 且不再返回 webhook token。',
        requestBody: request(
          object(
            {
              codeup_repository_id: {
                description: '云效仓库数字 ID。',
                oneOf: [
                  { type: 'string', pattern: '^\\d{1,30}$' },
                  { type: 'integer', minimum: 0 },
                ],
              },
              branch: { type: 'string', default: 'main', minLength: 1, maxLength: 255 },
              authorize_automatic_sync: {
                type: 'boolean',
                enum: [true],
                description: '明确授权使用当前绑定的云效凭据进行自动同步。',
              },
            },
            ['codeup_repository_id', 'authorize_automatic_sync'],
          ),
        ),
        responses: {
          '200': ok('该仓库已接入。', object({ repository: ref('Repository') }, ['repository'])),
          '202': ok('仓库已接入并已创建初始索引任务。', ref('CreatedRepository')),
          ...common,
        },
      },
    },
    '/api/v1/repositories/{repoId}': {
      get: {
        tags: ['仓库与索引'],
        summary: '查看仓库状态',
        parameters: [pathParam('repoId', 'CodeHarbor 仓库 ID')],
        responses: { '200': ok('仓库状态。', ref('Repository')), ...common },
      },
      delete: {
        tags: ['管理'],
        summary: '删除已禁用仓库',
        description: '需要管理员 Key；仅允许删除已禁用仓库，任务与权限缓存级联删除。',
        parameters: [pathParam('repoId', 'CodeHarbor 仓库 ID')],
        responses: {
          '200': ok('仓库已删除。', object({ deleted: { type: 'boolean', enum: [true] } }, ['deleted'])),
          ...common,
          '409': error('仓库未处于禁用状态。'),
        },
      },
    },
    '/api/v1/repositories/{repoId}/sync': {
      post: {
        tags: ['仓库与索引'],
        summary: '触发索引同步',
        description: '需要 write；返回任务 ID，可查询任务状态。',
        parameters: [pathParam('repoId', 'CodeHarbor 仓库 ID')],
        responses: { '202': ok('已接受任务。', jobId), ...common },
      },
    },
    '/api/v1/repositories/{repoId}/sync-credential': {
      put: {
        tags: ['仓库与索引'],
        summary: '重新授权自动同步凭据',
        description: '需要 write，且调用者是仓库所有者或当前同步凭据所有者；更新授权并触发任务。',
        parameters: [pathParam('repoId', 'CodeHarbor 仓库 ID')],
        requestBody: request(
          object({ authorize_automatic_sync: { type: 'boolean', enum: [true] } }, ['authorize_automatic_sync']),
        ),
        responses: { '202': ok('已授权并接受任务。', jobId), ...common },
      },
    },
    '/api/v1/repositories/{repoId}/disable': {
      post: {
        tags: ['管理'],
        summary: '禁用仓库',
        description: '需要管理员 Key。禁用后对所有 Key 不可见，不再同步。',
        parameters: [pathParam('repoId', 'CodeHarbor 仓库 ID')],
        responses: { '200': ok('仓库已禁用。', object({ repository: ref('Repository') }, ['repository'])), ...common },
      },
    },
    '/api/v1/repositories/{repoId}/enable': {
      post: {
        tags: ['管理'],
        summary: '恢复已禁用仓库并触发同步',
        parameters: [pathParam('repoId', 'CodeHarbor 仓库 ID')],
        responses: {
          '202': ok(
            '已恢复并接受任务。',
            object({ repository: ref('Repository'), job_id: { type: 'string' } }, ['repository', 'job_id']),
          ),
          ...common,
          '409': error('仓库未处于禁用状态。'),
        },
      },
    },
    '/api/v1/admin/repositories': {
      get: {
        tags: ['管理'],
        summary: '列出全部已接入仓库（含已禁用）',
        description: '面向平台管理员；普通仓库列表不包含已禁用仓库。',
        responses: {
          '200': ok(
            '仓库列表。',
            object({ repositories: { type: 'array', items: ref('AdminRepository') } }, ['repositories']),
          ),
          ...common,
        },
      },
    },
    '/api/v1/admin/users': {
      get: {
        tags: ['管理'],
        summary: '列出已绑定用户',
        responses: {
          '200': ok(
            '用户列表。',
            object(
              {
                users: {
                  type: 'array',
                  items: object({
                    id: { type: 'string' },
                    username: { type: 'string' },
                    credential_version: { type: 'integer' },
                  }),
                },
              },
              ['users'],
            ),
          ),
          ...common,
        },
      },
    },
    '/api/v1/admin/users/{userId}/revoke-keys': {
      post: {
        tags: ['管理'],
        summary: '撤销某用户的全部 Key',
        parameters: [pathParam('userId', '云效用户 ID')],
        responses: {
          '200': ok(
            '已撤销。',
            object({ revoked: { type: 'boolean' }, user: { type: 'string' } }, ['revoked', 'user']),
          ),
          ...common,
        },
      },
    },
    '/api/v1/admin/api-keys': {
      get: {
        tags: ['管理'],
        summary: '列出平台全部 Key',
        parameters: [
          { name: 'owner', in: 'query', schema: { type: 'string' } },
          {
            name: 'page',
            in: 'query',
            schema: { type: 'integer', minimum: 1, default: 1 },
            description: '每页 100 项。',
          },
        ],
        responses: {
          '200': ok(
            '密钥列表。',
            object(
              { keys: { type: 'array', items: ref('AdminKeyInfo') }, next_page: { type: 'integer', nullable: true } },
              ['keys', 'next_page'],
            ),
          ),
          ...common,
        },
      },
    },
    '/api/v1/admin/api-keys/{prefix}': {
      delete: {
        tags: ['管理'],
        summary: '撤销任意用户的 Key',
        parameters: [pathParam('prefix', '密钥前缀，如 ch_ 后跟 8 个字符')],
        responses: {
          '200': ok(
            '密钥已撤销。',
            object({ revoked: { type: 'boolean' }, owner: { type: 'string' }, prefix: { type: 'string' } }, [
              'revoked',
              'owner',
              'prefix',
            ]),
          ),
          ...common,
          '409': error('前缀对应多个密钥。'),
        },
      },
    },
    '/api/v1/admin/audit': {
      get: {
        tags: ['管理'],
        summary: '查询持久化审计事件',
        description: '按时间倒序。代码查询只记录 SHA-256 摘要，不记录内容。',
        parameters: [
          { name: 'subject', in: 'query', schema: { type: 'string' } },
          { name: 'repo_id', in: 'query', schema: { type: 'string' } },
          { name: 'since', in: 'query', schema: { type: 'integer' }, description: 'Unix 毫秒时间戳。' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 100 } },
        ],
        responses: {
          '200': ok('审计事件。', object({ events: { type: 'array', items: ref('AuditEvent') } }, ['events'])),
          ...common,
        },
      },
    },
    '/api/v1/jobs/{jobId}': {
      get: {
        tags: ['仓库与索引'],
        summary: '查看索引任务',
        parameters: [pathParam('jobId', '索引任务 ID')],
        responses: { '200': ok('任务状态。', ref('Job')), ...common },
      },
    },
    '/api/v1/repositories/{repoId}/jobs': {
      get: {
        tags: ['仓库与索引'],
        summary: '查看仓库的索引任务历史',
        description: '最新的任务在前，最多返回 50 条。',
        parameters: [pathParam('repoId', 'CodeHarbor 仓库 ID')],
        responses: {
          '200': ok('任务列表。', object({ jobs: { type: 'array', items: ref('Job') } }, ['jobs'])),
          ...common,
        },
      },
    },
    '/api/v1/api-keys': {
      get: {
        tags: ['API Key'],
        summary: '列出当前账号的密钥',
        description: '限定仓库范围的密钥只返回自身。不会返回密钥明文。',
        responses: {
          '200': ok('密钥列表。', object({ keys: { type: 'array', items: ref('KeyInfo') } }, ['keys'])),
          ...common,
        },
      },
      post: {
        tags: ['API Key'],
        summary: '创建 API Key',
        description:
          '需要 write。read Key 必须提供明确的 repos 仓库 ID 列表；新密钥的范围不能超过当前密钥，过期时间不能晚于当前密钥；只有无截止日期的父 Key 才能创建无限期下级 Key。Key 的 owner 固定为调用者，不支持指定目标用户；代发时审计主体仍是签发者，可用 Key 前缀区分。密钥明文仅返回一次。',
        requestBody: request(object({ scope, repos: repoScope, expires_in: expiresIn }, ['scope'])),
        responses: { '201': ok('密钥创建成功。', ref('CreatedKey')), ...common },
      },
    },
    '/api/v1/api-keys/{prefix}': {
      delete: {
        tags: ['API Key'],
        summary: '撤销 API Key',
        description: '需要 write；限定仓库范围的密钥只能撤销自身。',
        parameters: [pathParam('prefix', '密钥前缀，如 ch_ 后跟 8 个字符')],
        responses: {
          '200': ok('密钥已撤销。', object({ revoked: { type: 'boolean', enum: [true] } }, ['revoked'])),
          ...common,
        },
      },
    },
    '/api/v1/hooks/codeup/{repoId}': {
      post: {
        tags: ['Webhook'],
        summary: '接收云效 Push Hook',
        description:
          '使用仓库创建时返回的 webhook_token。Push Hook 项目 ID、分支和提交须匹配；非 Push Hook 或其他分支事件会被忽略但仍返回 202。全零 after 表示分支删除。',
        security: [{ WebhookToken: [] }],
        parameters: [
          pathParam('repoId', 'CodeHarbor 仓库 ID'),
          {
            name: 'codeup-event',
            in: 'header',
            required: false,
            schema: { type: 'string' },
            description: 'Push 事件应为 Push Hook。',
          },
        ],
        requestBody: request(
          object({
            object_kind: { type: 'string', enum: ['push'] },
            project_id: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
            ref: { type: 'string' },
            after: { type: 'string', pattern: '^[0-9a-f]{40,64}$' },
          }),
          true,
        ),
        responses: {
          '202': ok('事件已接受或被忽略。', object({ accepted: { type: 'boolean', enum: [true] } }, ['accepted'])),
          ...common,
        },
      },
    },
    '/mcp': {
      post: {
        tags: ['MCP'],
        summary: 'MCP Streamable HTTP 入口',
        description:
          '使用 CodeHarbor API Key，通过 MCP 客户端进行 initialize、tools/list 和 tools/call。工具包括 list_repositories、get_repository_status，以及 codegraph_search、codegraph_callers、codegraph_callees、codegraph_impact、codegraph_node、codegraph_explore、codegraph_files。代码工具必须传 repo_id；支持固定上游版本的参数（如 file、limit、maxFiles），不接受 projectPath 或仓库外路径。明确仓库列表的 Key 按列表授权；无范围 read Key 按持有者当前云效权限授权并缓存复核。每个 Key 每分钟有请求配额，超出返回 429。write 不能修改仓库代码。',
        requestBody: request({ type: 'object', description: 'MCP JSON-RPC 消息。' }, true),
        responses: {
          '200': { description: 'MCP 响应；格式和头部遵循 MCP 协议。' },
          '202': { description: 'MCP 通知已接受。' },
          '400': { description: 'MCP 协议请求错误。' },
          '401': { description: '认证失败；返回 MCP JSON-RPC 错误。' },
          '403': common['403'],
          '405': { description: '不支持的方法。' },
          '503': { description: '认证服务不可用；返回 MCP JSON-RPC 错误。' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKey: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'CodeHarbor API Key',
        description: '通过 API Key 管理接口获得；并非云效 PAT。',
      },
      BootstrapBearer: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Bootstrap token',
        description: '绑定云效 PAT 后得到的一次性短期令牌。',
      },
      MetricsBearer: { type: 'http', scheme: 'bearer', description: '单独配置的 metrics token。' },
      WebhookToken: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Codeup-Token',
        description: '接入仓库时返回的 webhook_token。',
      },
    },
    schemas: {
      Error: object(
        { error: { type: 'string', description: '稳定的错误代码，例如 UNAUTHENTICATED、FORBIDDEN、NOT_FOUND。' } },
        ['error'],
      ),
      Health: object({ status: { type: 'string', enum: ['ok', 'unavailable'] } }, ['status']),
      BootstrapSession: object(
        {
          bootstrap_token: { type: 'string' },
          expires_in: { type: 'integer', description: '单位秒。' },
          user: object({ id: { type: 'string' }, name: { type: 'string' } }, ['id', 'name']),
        },
        ['bootstrap_token', 'expires_in', 'user'],
      ),
      BootstrapKey: object(
        {
          token: { type: 'string' },
          prefix: { type: 'string' },
          scope,
          expires_in: { type: 'integer', nullable: true, description: '单位秒；null 表示无限期（无截止日期）。' },
        },
        ['token', 'prefix', 'scope', 'expires_in'],
      ),
      Me: object(
        {
          id: { type: 'string' },
          username: { type: 'string' },
          key_scope: scope,
          key_prefix: { type: 'string' },
          key_repos: repoScope,
          key_expires_at: { type: 'integer', nullable: true, description: 'Unix 毫秒时间戳。' },
          can_write: { type: 'boolean', description: '密钥可执行平台管理与触发索引。' },
          is_admin: { type: 'boolean', description: '无限定仓库范围的 write 密钥，由配置允许的用户持有。' },
        },
        ['id', 'username', 'key_scope', 'key_prefix', 'key_repos', 'key_expires_at', 'can_write', 'is_admin'],
      ),
      CodeupRepository: object(
        {
          id: { type: 'string' },
          name: { type: 'string' },
          path: { type: 'string' },
          access_level: { type: 'integer', nullable: true },
        },
        ['id', 'name', 'path', 'access_level'],
      ),
      Repository: object(
        {
          repo_id: { type: 'string' },
          codeup_id: { type: 'string', description: '云效仓库数字 ID。' },
          name: { type: 'string' },
          branch: { type: 'string' },
          status: { type: 'string' },
          indexed_commit: { type: 'string', nullable: true },
          indexed_at: { type: 'string', format: 'date-time', nullable: true },
          stale: { type: 'boolean' },
          error: { type: 'string', nullable: true },
          webhook_path: { type: 'string', description: 'Codeup Webhook 路径；token 仅在接入时返回。' },
        },
        [
          'repo_id',
          'codeup_id',
          'name',
          'branch',
          'status',
          'indexed_commit',
          'indexed_at',
          'stale',
          'error',
          'webhook_path',
        ],
      ),
      AdminRepository: object(
        {
          repo_id: { type: 'string' },
          codeup_id: { type: 'string' },
          name: { type: 'string' },
          branch: { type: 'string' },
          status: { type: 'string' },
          indexed_commit: { type: 'string', nullable: true },
          indexed_at: { type: 'string', format: 'date-time', nullable: true },
          stale: { type: 'boolean' },
          error: { type: 'string', nullable: true },
          webhook_path: { type: 'string' },
          owner: { type: 'string', description: '接入者用户 ID。' },
          sync_owner: { type: 'string', description: '当前同步凭证持有人用户 ID。' },
        },
        [
          'repo_id',
          'codeup_id',
          'name',
          'branch',
          'status',
          'indexed_commit',
          'indexed_at',
          'stale',
          'error',
          'webhook_path',
          'owner',
          'sync_owner',
        ],
      ),
      CreatedRepository: object(
        {
          repository: ref('Repository'),
          job_id: { type: 'string' },
          webhook_token: { type: 'string', description: '仅此响应返回，需妥善保存。' },
          webhook_path: { type: 'string' },
        },
        ['repository', 'job_id', 'webhook_token', 'webhook_path'],
      ),
      Job: object(
        {
          id: { type: 'string' },
          repo_id: { type: 'string' },
          status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed'] },
          reason: { type: 'string' },
          created_at: { type: 'integer', description: '首次创建时的 Unix 毫秒时间戳。' },
          queued_at: {
            type: 'integer',
            nullable: true,
            description: '最近入队时的 Unix 毫秒时间戳；历史记录可能为空。',
          },
          finished_at: { type: 'integer', nullable: true, description: '终态时的 Unix 毫秒时间戳；历史记录可能为空。' },
          build_duration_ms: {
            type: 'integer',
            nullable: true,
            description: '实际构建耗时（毫秒）；未构建和历史记录为空。',
          },
          error: { type: 'string', nullable: true },
        },
        ['id', 'repo_id', 'status', 'reason', 'created_at', 'queued_at', 'finished_at', 'build_duration_ms', 'error'],
      ),
      AdminKeyInfo: object(
        {
          prefix: { type: 'string' },
          owner: { type: 'string' },
          scope,
          repos: repoScope,
          expires_at: { type: 'integer', nullable: true },
          revoked: { type: 'boolean' },
        },
        ['prefix', 'owner', 'scope', 'repos', 'expires_at', 'revoked'],
      ),
      AuditEvent: object({
        id: { type: 'string' },
        at: { type: 'integer' },
        request_id: { type: 'string' },
        method: { type: 'string' },
        route: { type: 'string' },
        status: { type: 'integer' },
        authentication: { type: 'string', nullable: true },
        subject: { type: 'string', nullable: true },
        key_prefix: { type: 'string', nullable: true },
        repo_id: { type: 'string', nullable: true },
        tool: { type: 'string', nullable: true },
        tool_outcome: { type: 'string', nullable: true },
        query_hash: { type: 'string', nullable: true },
      }),
      KeyInfo: object(
        {
          prefix: { type: 'string' },
          scope,
          repos: repoScope,
          expires_at: { type: 'integer', nullable: true, description: 'Unix 毫秒时间戳。' },
          revoked: { type: 'boolean' },
        },
        ['prefix', 'scope', 'repos', 'expires_at', 'revoked'],
      ),
      CreatedKey: object(
        {
          token: { type: 'string', description: '仅此响应返回，需妥善保存。' },
          prefix: { type: 'string' },
          scope,
          repos: repoScope,
          expires_at: { type: 'integer', nullable: true, description: 'Unix 毫秒时间戳；null 表示无截止日期。' },
        },
        ['token', 'prefix', 'scope', 'repos', 'expires_at'],
      ),
    },
  },
} as OpenApiDocument;
