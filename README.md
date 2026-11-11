# CodeHarbor

CodeHarbor 是面向 Agent 的代码知识服务：它拉取云效 Codeup 仓库，分别构建 CodeGraph 索引，并通过统一 MCP 入口提供按用户和仓库鉴权的查询。当前实现提供单节点生产化基础，技术设计见 [设计文档](docs/CodeHarbor-技术设计方案.md)。

## 当前范围

- 用户使用云效个人访问令牌（PAT）绑定身份，创建只读或平台读写 CodeHarbor Key。
- 使用 Codeup 仓库 ID 接入仓库，首次及变化后以独立目录全量构建 CodeGraph 1.6.2 索引；相同 commit 不重复构建。
- Codeup Push Webhook、手动同步和 15 分钟对账；保留上次成功索引，报告 commit 和新鲜度。
- 单个 `/mcp` 地址，提供 `list_repositories`、`get_repository_status`、`codegraph_explore`；每次调用按用户云效权限及 Key 仓库范围鉴权。
- `write` Key 仅允许平台管理及触发索引，不能写云效代码。
- 可选择仓库镜像后端：每个仓库的源码快照和索引打包为本机 Docker 镜像，查询容器使用经过适配的只读 CodeGraph；配置和迁移边界见 [镜像后端指南](docs/image-backend.md)。

**使用边界**：此版本在生产模式使用 PostgreSQL 和 Vault Transit；仍是单进程 Worker，不支持多副本或跨进程租约与 fencing。它尚未通过真实云效账号和企业权限策略联调；部署前需验证云效身份、克隆/下载管控、继承权限和浏览者实际代码访问权。未经这些验证不要用于生产多租户环境。Index Worker 和共享 CodeGraph 进程还需要部署级文件系统及网络隔离；源码和索引须按源码等级保护。发布后保留当前及上一个受管理的索引版本；未知或无所有权标记的旧目录不会自动删除。

查询仓库时，以调用者自己的云效 PAT 验证 HTTPS Git 对象下载；索引同步另使用仓库授权的同步账号。验证最多并发 2 次，每次总超时 30 秒、响应不超过 32 MiB 和 100,000 个对象；空仓库、没有可探测分支或服务器不支持 shallow 时无法验证。超时、超限和校验失败会拒绝访问，并返回授权不可用；探测需要临时目录空间，详见 [生产部署指南](docs/production-deployment.md)。

## 开发运行

需要 Node.js 22.13+（本项目限定 Node 22）、Git 和可访问的云效 Codeup；CodeGraph npm 包版本已固定，`npm ci` 会安装对应平台的可执行文件。

```sh
npm ci
npm run build
```

索引任务会执行位于临时目录和数据目录中的 Git 凭证助手，因此这两个目录须允许执行文件；若挂载为 `noexec`，任务会失败。测试也会在临时目录运行测试夹具。生产部署应将这两个目录限制为服务专用。

开发环境可使用本地主密钥；生产必须使用 PostgreSQL 和 Vault Transit。确保主密钥重启后保持不变并备份：主密钥丢失将无法解密已绑定 PAT。通过服务管理器或容器密钥机制设置以下环境变量（示例值不含实际凭证）：

| 变量 | 说明 |
|---|---|
| `CODEHARBOR_MASTER_KEY` | 本地开发模式使用的 Base64 编码 32 字节密钥；与数据目录分开保存；生产不使用此模式 |
| `DATABASE_URL` 或 `CODEHARBOR_DATABASE_URL_FILE` | PostgreSQL 连接串或受保护的连接串文件，二者只能设置一个；生产必须启用 `sslmode=verify-full` |
| `CODEHARBOR_KEY_PROVIDER` | 生产设为 `vault-transit`；Vault 配置见 [Vault Transit 文档](docs/vault-transit.md) |
| `CODEHARBOR_METRICS_TOKEN_FILE` | 可选，独立监控 Bearer 密钥文件；未配置时 `/metrics` 不开放 |
| `YUNXIAO_ENDPOINT` | 必填，可信云效 API HTTPS 源，例如 `https://example.yunxiao.example` |
| `YUNXIAO_ORGANIZATION_ID` | 云效中心版组织 ID；Region 版按实际 API 配置 |
| `CODEHARBOR_GIT_HOSTS` | 必填，允许拉取的 HTTPS Git 主机，逗号分隔；包含非标准端口时写 `host:port` |
| `CODEHARBOR_WRITE_USERS` | 允许申请平台 write Key 的云效用户 ID，逗号分隔；默认无人可写 |
| `CODEHARBOR_DATA_DIR` | 持久化目录，默认 `./data` |
| `CODEHARBOR_BIND`、`PORT` | 默认 `127.0.0.1:8080` |
| `CODEHARBOR_ALLOWED_HOSTS` | 允许的 HTTP Host，逗号分隔；默认允许本地 `127.0.0.1` 和 `localhost` 带端口 |
| `CODEHARBOR_ALLOWED_ORIGINS` | 允许的浏览器 Origin；默认不允许携带 Origin 的请求 |
| `CODEGRAPH_BIN` | 可选，覆盖 CodeGraph 可执行文件路径 |

运行 `npm start`。`NODE_ENV=production` 会强制要求 PostgreSQL 验证服务端证书和 Vault Transit，不能退回 SQLite/本地密钥。其他模式若不配置 PostgreSQL 则使用 SQLite。生产数据库连接应直连或使用 session pooling，不可使用事务池，因为实例互斥锁依赖持续的数据库会话；会话断开后拒绝读写，需由 supervisor 重启。业务进程与 Worker 同实例运行，仍不能横向扩容。

本服务不直接提供 TLS；跨主机访问时必须将其置于可信 TLS 反向代理后，限制内部 HTTP 入口，正确设置允许的 Host 和 Origin。不要向公网直接开放明文端口。健康检查为 `GET /health/live` 和 `GET /health/ready`；后者检查数据库，工作树模式下检查上游 MCP 工具 schema，镜像模式下检查镜像调度控制器。`/metrics` 在配置独立 Bearer 密钥后提供聚合 HTTP 与索引队列指标，不包含源码、仓库或用户标签；仅限内网采集。指标含义和查询示例见[队列监控](docs/queue-metrics.md)。结构化 HTTP 和审计事件输出到 stdout，生产环境须配置访问受控的日志采集、留存和告警。

## 接口文档

服务启动后访问 `/docs` 查看 Swagger UI，或通过 `/openapi.json` 获取 OpenAPI 定义。页面使用服务本地提供的资源，管理接口可通过 **Authorize** 填写 CodeHarbor Key 后调试；具体权限仍由服务端检查，`write` 只允许平台管理及触发索引。建议继续使用交互式 CLI 绑定云效 PAT，避免在浏览器中输入或保存 PAT。新建的 Key、引导凭证和 Webhook Token 仅在创建时返回一次，须妥善保存。

浏览器调用 API 时，须将页面实际的完整 Origin（例如 `https://codegraph.sigmob.com`）加入 `CODEHARBOR_ALLOWED_ORIGINS`，并确保 `CODEHARBOR_ALLOWED_HOSTS` 允许反向代理传递的 Host。文档页面和规范本身不要求登录；Host 白名单并非身份认证。生产环境应按企业策略在网关或网络层控制 `/docs`、`/docs/` 及其子路径和 `/openapi.json` 的访问，并只在可信浏览器中调试。文档中的健康检查和监控端点默认不经部署模板中的 Nginx 对外开放。

## 初次绑定与使用

使用可信终端中的交互 CLI 绑定 PAT；不要将 PAT 写入命令参数、聊天消息或 shell 历史。令牌需要云效用户、仓库只读和 HTTPS Git 读取的必要权限，具体 scope 以企业云效版本为准：

```sh
node dist/cli.js bind --url http://127.0.0.1:8080 --scope read
# 要创建 write Key：先将自己的云效用户 ID 加入 CODEHARBOR_WRITE_USERS 并重启，随后使用 --scope write
```

CLI 隐藏 PAT 输入；CodeHarbor Key 明文只返回一次，使用者应自行安全保存。也可调用 `POST /api/v1/auth/yunxiao/bind` 和 `POST /api/v1/auth/bootstrap/keys`；PAT 只能经可信 TLS 或本机回环传输，首次引导凭证有效 5 分钟且只能使用一次。重新绑定同一用户的 PAT 可更新凭证，不应在未验证云效权限状态时认为其他用户的索引可访问。

管理端点需要 Bearer Key：

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/v1/me` | 当前用户和 Key 权限 |
| GET | `/api/v1/codeup/repositories?page=1` | 查询云效可见仓库；仅适用于不限定仓库范围的 Key |
| GET / POST | `/api/v1/repositories` | 列出有权索引仓库 / 接入云效仓库 |
| GET | `/api/v1/repositories/{id}` | 仓库索引状态 |
| POST | `/api/v1/repositories/{id}/sync` | 异步更新索引 |
| PUT | `/api/v1/repositories/{id}/sync-credential` | 仓库负责人或现同步凭证持有人明确授权自己的当前 PAT 用于同步 |
| GET | `/api/v1/jobs/{id}` | 任务状态 |
| GET / POST | `/api/v1/api-keys` | 查看 / 创建本人下级 Key |
| DELETE | `/api/v1/api-keys/{prefix}` | 撤销本人 Key |
| POST | `/api/v1/hooks/codeup/{id}` | Codeup Webhook，使用 `X-Codeup-Token` |

接入需要 write Key，JSON 包含 `codeup_repository_id`、`branch` 和 `authorize_automatic_sync: true`。成功响应包含 CodeHarbor 仓库 ID、任务 ID，以及仅返回一次的 `webhook_path` 和 `webhook_token`。将该路径配置到 Codeup 普通 Webhook，填写 Secret Token 并选择 Push 事件；无法配置 Webhook 时仍可手动同步，后台定期对账也会补偿。不要记录或公开 Webhook Token。平台仅使用接入者已授权的 PAT 自动同步，不自动借用其他用户的令牌。

当同步凭证持有人重新绑定 PAT 时，已有仓库不会自动使用新令牌：仓库进入 `credential_required`，该用户或仓库负责人需使用自己的 write Key 请求 `PUT /api/v1/repositories/{id}/sync-credential`，提交 `{"authorize_automatic_sync":true}`，明确授权当前 PAT 并重新排队。未发布索引和旧索引仍按各自的仓库权限保护。

Agent 配置 MCP URL `https://<trusted-host>/mcp` 和 `Authorization: Bearer <CodeHarbor Key>`；具体配置格式取决于 MCP 客户端。先调用 `list_repositories`，然后在 `codegraph_explore` 中传入 `repo_id` 和 `query`。不要向 Agent 暴露云效 PAT。

## 测试

```sh
CODEGRAPH_TEST_BIN="$PWD/node_modules/.bin/codegraph" npm test
```

测试包括虚拟 Codeup 权限、MCP 隔离、Webhook、任务及真实 CodeGraph 多仓库查询。设置 `CODEHARBOR_TEST_DATABASE_URL` 后还执行真实 PostgreSQL 的迁移、实例锁和 HTTP/MCP 集成测试；该测试需要可创建和删除测试数据库的独立测试账号。虚拟云效测试不代表真实云效端到端验证。

## 容器

```sh
docker build -t codeharbor:dev .
```

容器以非 root 用户运行，数据保存在 `/data`。生产部署可选择外部 PostgreSQL，或叠加 [本地 PostgreSQL Compose 配置](deploy/compose.postgres.yaml) 在 Docker 中运行数据库；两种方式均要求经验证的 PostgreSQL TLS、Vault Transit 和 HTTPS 反向代理。配置及启动步骤见 [部署指南](docs/production-deployment.md)。模板不会创建企业凭证或自动部署服务；生产使用前仍须验证实际云效权限、备份恢复和运行隔离。
