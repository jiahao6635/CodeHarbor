// Keep this contract aligned with the handlers in src/routes/*. MCP RPC is described
// at the transport boundary; its tool schemas are provided by tools/list.
import type { StaticDocumentSpec } from '@fastify/swagger';
import { JOB_PHASES } from './store.js';

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
  description: 'write 还可触发有权维护的仓库同步。',
};
const expiresIn = {
  type: 'integer',
  nullable: true,
  minimum: 60,
  maximum: 7776000,
  default: 2592000,
  description: '有效期，单位秒；省略时默认 30 天，有限期限最多 90 天；显式 null 表示无限期（无截止日期），仍可撤销。',
};
const repoScope = { ...strings, nullable: true, maxItems: 100, description: '限定的 CodeHarbor 仓库 ID。' };
const browserSecurity = [{ BrowserSession: [] }];
const keySecurity = [{ ApiKey: [] }];
const accountRole = { type: 'string', enum: ['member', 'super_admin'] };
const accountStatus = { type: 'string', enum: ['active', 'disabled'] };
const jobId = object({ job_id: { type: 'string' } }, ['job_id']);

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'CodeHarbor API',
    version: '0.1.0',
    description:
      '通过飞书登录管理 CodeHarbor 账号和 API Key。REST 与 MCP 的 Key 权限取明确仓库范围和持有人的当前云效权限的交集。',
  },
  servers: [{ url: '/' }],
  security: [...browserSecurity, ...keySecurity],
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
    '/api/v1/auth/feishu/start': {
      get: {
        tags: ['认证'],
        summary: '开始飞书登录',
        security: [],
        responses: { '302': { description: '跳转到飞书授权。' } },
      },
    },
    '/api/v1/auth/feishu/callback': {
      get: {
        tags: ['认证'],
        summary: '飞书登录回调',
        security: [],
        responses: { '302': { description: '跳转到控制台。' } },
      },
    },
    '/api/v1/auth/logout': {
      post: {
        tags: ['认证'],
        security: browserSecurity,
        summary: '退出飞书会话',
        responses: { '204': { description: '已退出。' }, ...common },
      },
    },
    '/api/v1/auth/yunxiao/bind': {
      post: {
        tags: ['认证'],
        summary: '绑定云效个人访问令牌',
        description: '用当前飞书会话绑定自己的 PAT。更换 PAT 后，受影响的仓库需要重新确认同步授权。',
        security: browserSecurity,
        requestBody: request(
          object({ pat: { type: 'string', minLength: 1, maxLength: 4096, format: 'password' } }, ['pat']),
        ),
        responses: {
          '200': ok(
            '绑定成功。',
            object({ user: object({ id: { type: 'string' }, name: { type: 'string' } }, ['id', 'name']) }, ['user']),
          ),
          ...common,
          '409': error('该云效账号已被认领，或当前飞书账号已绑定其他云效账号。'),
          '429': error('绑定请求过于频繁。'),
        },
      },
    },
    '/api/v1/me': {
      get: {
        tags: ['认证'],
        summary: '当前会话或密钥身份',
        responses: { '200': ok('当前身份。', ref('Me')), ...common },
      },
    },
    '/api/v1/codeup/repositories': {
      get: {
        tags: ['云效仓库'],
        summary: '列出云效可见仓库',
        description: '使用当前飞书账号绑定的云效 PAT。接入仓库时另行检查克隆权限。',
        security: browserSecurity,
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
    '/api/v1/codeup/repositories/{id}/branches': {
      get: {
        tags: ['云效仓库'],
        summary: '搜索云效仓库的真实分支',
        security: browserSecurity,
        parameters: [
          pathParam('id', '云效仓库数字 ID'),
          { name: 'search', in: 'query', schema: { type: 'string', maxLength: 255 } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        ],
        responses: {
          '200': ok(
            '仓库分支。',
            object(
              {
                branches: {
                  type: 'array',
                  items: object({ name: { type: 'string' }, is_default: { type: 'boolean' } }, ['name', 'is_default']),
                },
                default_branch: { type: 'string', nullable: true },
                next_page: { type: 'integer', nullable: true },
              },
              ['branches', 'default_branch', 'next_page'],
            ),
          ),
          ...common,
          '409': error('需要绑定或更新 PAT。'),
        },
      },
    },
    '/api/v1/repositories': {
      get: {
        tags: ['仓库与索引'],
        summary: '列出当前身份可访问的已接入仓库',
        parameters: [
          {
            name: 'for_key',
            in: 'query',
            schema: { type: 'string', enum: ['1'] },
            description: '在飞书会话中按个人云效权限列出可选择的仓库。',
          },
        ],
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
          '以飞书会话和已绑定的 PAT 接入并验证分支。每个云效仓库跟踪一个分支，重复提交相同分支返回已有仓库。首次接入只返回一次 Webhook token。',
        security: browserSecurity,
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
              branch: { type: 'string', minLength: 1, maxLength: 255, description: '省略时使用云效默认分支。' },
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
          '409': ok(
            '已跟踪其他分支，或云效 PAT 当前不可用。',
            object({ error: { type: 'string' }, repository: ref('Repository') }, ['error']),
          ),
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
        description: '超级管理员可删除已禁用的仓库，任务与权限缓存级联删除。',
        security: browserSecurity,
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
        description: '仓库接入者或同步凭证持有人可触发任务；使用 Key 时需要 write。',
        parameters: [pathParam('repoId', 'CodeHarbor 仓库 ID')],
        responses: { '202': ok('已接受任务。', jobId), ...common },
      },
    },
    '/api/v1/repositories/{repoId}/sync-credential': {
      put: {
        tags: ['仓库与索引'],
        summary: '重新授权自动同步凭据',
        description: '仓库接入者或当前同步凭证持有人用飞书会话更新授权并触发任务。',
        security: browserSecurity,
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
        description: '超级管理员可以禁用仓库。禁用的仓库停止同步。',
        security: browserSecurity,
        parameters: [pathParam('repoId', 'CodeHarbor 仓库 ID')],
        responses: { '200': ok('仓库已禁用。', object({ repository: ref('Repository') }, ['repository'])), ...common },
      },
    },
    '/api/v1/repositories/{repoId}/enable': {
      post: {
        tags: ['管理'],
        summary: '恢复已禁用仓库并触发同步',
        security: browserSecurity,
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
        security: browserSecurity,
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
        security: browserSecurity,
        summary: '列出飞书用户',
        responses: {
          '200': ok(
            '用户列表。',
            object(
              {
                users: {
                  type: 'array',
                  items: ref('Account'),
                },
              },
              ['users'],
            ),
          ),
          ...common,
        },
      },
    },
    '/api/v1/admin/users/{userId}': {
      patch: {
        tags: ['管理'],
        security: browserSecurity,
        summary: '变更平台用户角色或状态',
        parameters: [pathParam('userId', '平台账号 ID')],
        requestBody: request(object({ role: accountRole, status: accountStatus })),
        responses: {
          '200': ok('已更新账号。', object({ user: ref('Account') }, ['user'])),
          ...common,
          '409': error('最后一位启用的超级管理员不可停用或降级。'),
        },
      },
    },
    '/api/v1/admin/users/{userId}/revoke-keys': {
      post: {
        tags: ['管理'],
        security: browserSecurity,
        summary: '撤销某用户的全部 Key',
        parameters: [pathParam('userId', '平台账号 ID')],
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
        security: browserSecurity,
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
    '/api/v1/admin/api-keys/{prefix}/approve': {
      post: {
        tags: ['管理'],
        security: browserSecurity,
        summary: '审核并启用限定仓库的旧 API Key',
        parameters: [pathParam('prefix', '密钥前缀')],
        responses: {
          '200': ok(
            '已通过审核。',
            object({ approved: { type: 'boolean' }, owner: { type: 'string' }, prefix: { type: 'string' } }, [
              'approved',
              'owner',
              'prefix',
            ]),
          ),
          ...common,
          '409': error('Key 或持有人当前状态不允许审核通过。'),
        },
      },
    },
    '/api/v1/admin/api-keys/{prefix}': {
      delete: {
        tags: ['管理'],
        security: browserSecurity,
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
        security: browserSecurity,
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
        security: browserSecurity,
        summary: '列出当前账号的密钥',
        description: '列出本人名下的 Key 前缀和元数据。',
        responses: {
          '200': ok('密钥列表。', object({ keys: { type: 'array', items: ref('KeyInfo') } }, ['keys'])),
          ...common,
        },
      },
      post: {
        tags: ['API Key'],
        security: browserSecurity,
        summary: '创建 API Key',
        description: '创建限定仓库的 Key。权限随持有人的云效访问权限变化。密钥明文仅返回一次。',
        requestBody: request(
          object(
            { scope, repos: { ...strings, minItems: 1, maxItems: 100, uniqueItems: true }, expires_in: expiresIn },
            ['scope', 'repos'],
          ),
        ),
        responses: { '201': ok('密钥创建成功。', ref('CreatedKey')), ...common },
      },
    },
    '/api/v1/api-keys/{prefix}': {
      delete: {
        tags: ['API Key'],
        security: browserSecurity,
        summary: '撤销 API Key',
        description: '在飞书会话中撤销本人名下的密钥。',
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
        security: keySecurity,
        description:
          '使用 CodeHarbor API Key，通过 MCP 客户端进行 initialize、tools/list 和 tools/call。工具包括 list_repositories、get_repository_status，以及 codegraph_search、codegraph_callers、codegraph_callees、codegraph_impact、codegraph_node、codegraph_explore、codegraph_files。代码工具必须传 repo_id；支持固定上游版本的参数（如 file、limit、maxFiles），不接受 projectPath 或仓库外路径。权限取 Key 仓库范围和持有人云效权限的交集，源码查询还核验对应分支的克隆权限。每个 Key 每分钟有请求配额，超出返回 429。write 不能修改仓库代码。',
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
      BrowserSession: {
        type: 'apiKey',
        in: 'cookie',
        name: '__Host-codeharbor_session',
        description: '通过飞书登录获得。',
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
      Account: object(
        {
          id: { type: 'string' },
          username: { type: 'string' },
          name: { type: 'string' },
          role: accountRole,
          status: accountStatus,
          codeup_user_id: { type: 'string', nullable: true },
          has_pat: { type: 'boolean' },
        },
        ['id', 'username', 'role', 'status', 'codeup_user_id', 'has_pat'],
      ),
      Me: object(
        {
          id: { type: 'string' },
          username: { type: 'string' },
          role: accountRole,
          has_pat: { type: 'boolean' },
          key_scope: { ...scope, nullable: true },
          key_prefix: { type: 'string', nullable: true },
          key_repos: repoScope,
          key_expires_at: { type: 'integer', nullable: true, description: 'Unix 毫秒时间戳。' },
          can_write: { type: 'boolean', description: '账号可接入仓库，或密钥具备同步能力。' },
          is_admin: { type: 'boolean', description: '飞书会话属于超级管理员。' },
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
          can_manage: { type: 'boolean' },
          can_authorize_sync: { type: 'boolean' },
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
          phase: {
            type: 'string',
            nullable: true,
            enum: [...JOB_PHASES, null],
            description: '当前或最后执行的阶段。历史记录可能为空。',
          },
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
        [
          'id',
          'repo_id',
          'status',
          'phase',
          'reason',
          'created_at',
          'queued_at',
          'finished_at',
          'build_duration_ms',
          'error',
        ],
      ),
      AdminKeyInfo: object(
        {
          prefix: { type: 'string' },
          owner: { type: 'string' },
          scope,
          repos: repoScope,
          expires_at: { type: 'integer', nullable: true },
          revoked: { type: 'boolean' },
          legacy_pending: { type: 'boolean' },
          legacy_approvable: { type: 'boolean' },
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
          legacy_pending: { type: 'boolean' },
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
