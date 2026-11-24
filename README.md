# CodeHarbor

CodeHarbor 是面向 Agent 的代码知识服务：它拉取云效 Codeup 仓库，分别构建 CodeGraph 索引，并通过统一 MCP 入口提供按用户和仓库鉴权的查询。当前实现提供单节点生产化基础，技术设计见 [设计文档](docs/CodeHarbor-技术设计方案.md)。

## 当前范围

- 用户使用企业飞书账号登录，再绑定自己的云效个人访问令牌（PAT）和创建限定仓库的 CodeHarbor API Key。
- 从云效列表或按仓库 ID 选择仓库与远程分支。首次接入及提交变化后构建 CodeGraph 1.6.2 索引，详情页展示任务进度。相同 commit 的可用索引可以复用。
- Codeup Push Webhook、手动同步和 15 分钟对账；保留上次成功索引，报告 commit 和新鲜度。
- 单个 `/mcp` 地址，提供 `list_repositories`、`get_repository_status` 和全部 7 个代码工具：`codegraph_search`、`codegraph_callers`、`codegraph_callees`、`codegraph_impact`、`codegraph_node`、`codegraph_explore`、`codegraph_files`；全部代码工具必须传入 `repo_id`，按 Key 的仓库范围鉴权。
- `write` Key 可在限定仓库范围内触发本人负责的仓库同步。平台管理使用超级管理员的飞书登录会话。
- 生产模式使用仓库镜像后端：每个仓库的源码快照和索引打包为本机 Docker 镜像，查询容器使用经过适配的只读 CodeGraph；文件系统后端仅保留给开发和测试，配置与迁移边界见 [镜像后端指南](docs/image-backend.md)。

**使用边界**：此版本在生产模式使用 PostgreSQL、Vault Transit 和镜像索引后端；仍是单进程 Worker，不支持多副本或跨进程租约与 fencing。它尚未通过真实云效账号和企业权限策略联调；部署前需验证云效身份、克隆/下载管控、继承权限和浏览者实际代码访问权。未经这些验证不要用于生产多租户环境。生产模板将索引工作区放在限额 tmpfs，并限制应用 CPU、内存和 PID；包含源码和索引的镜像及镜像层仍须按源码等级保护并监控容量。

普通成员通过自己的 PAT 查看具有云效访问角色的已接入仓库。超级管理员可查看所有已接入仓库，包括已禁用仓库。所有 MCP Key 都限定仓库范围，查询源码还要求持有人具有云效访问角色及跟踪分支的 HTTPS 克隆权限。权限检查的缓存上限为 5 分钟。平台撤销 Key 或停用账号后，后续请求即时受限。仓库首次接入和同步使用获明确授权的个人 PAT，失败时保留上一次成功的索引。详见 [生产部署指南](docs/production-deployment.md)。

## 开发运行

需要 Node.js 22.13+（本项目限定 Node 22）、Git、Docker（用于本地 PostgreSQL 和测试）以及可访问的云效 Codeup；CodeGraph npm 包版本已固定，`npm ci` 会安装对应平台的可执行文件。

```sh
npm ci
npm run check   # tsc --noEmit + biome check
npm run build
```

代码风格由 [Biome](biome.json) 统一（120 列、单引号、禁止一行多语句），提交前运行 `npm run lint:fix`。

平台元数据只支持 PostgreSQL。schema 由 `migrations/*.sql` 管理：文件按 `NNNN_name.sql` 连续编号，服务启动时在持有实例锁的会话中按序执行未应用的版本并记入 `schema_migrations`；版本回退或改名会拒绝启动。已有迁移记录的数据库会顺序应用飞书账号、旧 Key 复核及任务进度等新增迁移。升级前先备份数据库。本地开发可直接使用测试数据库：

```sh
npm run test:db:up
export DATABASE_URL='postgres://codeharbor_test:codeharbor_test@127.0.0.1:54329/postgres'
```

索引任务会执行位于临时目录和数据目录中的 Git 凭证助手，因此这两个目录须允许执行文件；若挂载为 `noexec`，任务会失败。测试也会在临时目录运行测试夹具。生产部署应将这两个目录限制为服务专用。

开发环境可使用本地主密钥；生产必须使用 PostgreSQL 和 Vault Transit。确保主密钥重启后保持不变并备份：主密钥丢失将无法解密已绑定 PAT。通过服务管理器或容器密钥机制设置以下环境变量（示例值不含实际凭证）：

| 变量 | 说明 |
|---|---|
| `CODEHARBOR_MASTER_KEY` | 本地开发模式使用的 Base64 编码 32 字节密钥；与数据目录分开保存；生产不使用此模式 |
| `DATABASE_URL` 或 `CODEHARBOR_DATABASE_URL_FILE` | 必填，PostgreSQL 连接串或受保护的连接串文件，二者任选其一。生产连接串须指定 `sslmode=verify-full` 或 `sslmode=disable` |
| `CODEHARBOR_KEY_PROVIDER` | 生产设为 `vault-transit`；Vault 配置见 [Vault Transit 文档](docs/vault-transit.md) |
| `CODEHARBOR_INDEX_BACKEND` | 生产必须为 `image`；默认的 `filesystem` 仅用于开发和测试 |
| `CODEHARBOR_METRICS_TOKEN_FILE` | 可选，独立监控 Bearer 密钥文件；未配置时 `/metrics` 不开放 |
| `CODEHARBOR_MCP_QUERY_CONCURRENCY` | 镜像模式并发查询上限，默认 `10`，可设 `1`～`32`；平台与镜像控制器必须一致 |
| `YUNXIAO_ENDPOINT` | 必填，可信云效 API HTTPS 源，例如 `https://example.yunxiao.example` |
| `YUNXIAO_ORGANIZATION_ID` | 云效中心版组织 ID；Region 版按实际 API 配置 |
| `CODEHARBOR_GIT_HOSTS` | 必填，允许拉取的 HTTPS Git 主机，逗号分隔；包含非标准端口时写 `host:port` |
| `CODEHARBOR_PUBLIC_ORIGIN` | 控制台公开 Origin，生产必须为 HTTPS。飞书回调固定为该 Origin 下的 `/api/v1/auth/feishu/callback` |
| `CODEHARBOR_FEISHU_APP_ID`、`CODEHARBOR_FEISHU_TENANT_KEY` | 企业飞书自建应用 ID 和允许登录的租户标识 |
| `CODEHARBOR_FEISHU_APP_SECRET_FILE` | 保存飞书 App Secret 的受保护文件路径 |
| `CODEHARBOR_FEISHU_SUPER_ADMIN_OPEN_ID` | 初始超级管理员在该飞书应用中的 Open ID。指定账号首次成功登录且平台还没有启用的超级管理员时初始化角色 |
| `CODEHARBOR_ACCESS_TTL_MS` | 云效角色和克隆权限检查的缓存上限可调低，实际最长 5 分钟 |
| `CODEHARBOR_TRUST_PROXY` | `true` 时客户端地址取 `X-Forwarded-For` 最后一跳；仅在可信反向代理后开启 |
| `CODEHARBOR_DOCS_ENABLED` | 是否提供 `/docs` 与 `/openapi.json`；生产默认 `false` |
| `CODEHARBOR_UI_ENABLED` | 是否在 `/ui` 提供管理控制台，默认 `true`；需要先构建 `web/dist`（`npm run build:web`），显式设为 `true` 但缺少构建产物时启动失败 |
| `CODEHARBOR_UI_DIR` | 可选，覆盖控制台构建产物目录，默认 `web/dist` |
| `CODEHARBOR_UI_MCP_URL` | 可选，控制台「MCP 接入」页展示的 MCP 地址；不填时使用控制台自身域名下的 `/mcp` |
| `CODEHARBOR_MCP_KEY_RATE_PER_MIN` | 每个 Key 每分钟的 `/mcp` 请求配额，默认 `120`，超出返回 429 |
| `CODEHARBOR_AUTH_FAILURE_RATE_PER_MIN` | 每个客户端地址每分钟允许的 Bearer 认证失败次数，默认 `30` |
| `CODEHARBOR_AUDIT_RETENTION_DAYS` | 持久化审计事件保留天数，默认 `180` |
| `CODEHARBOR_DATA_DIR` | 持久化目录，默认 `./data` |
| `CODEHARBOR_BIND`、`PORT` | 默认 `127.0.0.1:8080` |
| `CODEHARBOR_ALLOWED_HOSTS` | 允许的 HTTP Host，逗号分隔；默认允许本地 `127.0.0.1` 和 `localhost` 带端口 |
| `CODEHARBOR_ALLOWED_ORIGINS` | 额外允许经过通用 HTTP Origin 检查的来源。飞书会话的写操作要求原始控制台 Origin |
| `CODEGRAPH_BIN` | 可选，覆盖 CodeGraph 可执行文件路径 |

运行 `npm start`。`NODE_ENV=production` 要求完整的飞书登录配置、验证 PostgreSQL 服务端证书、Vault Transit 和镜像索引后端。服务使用一条专用会话持有实例互斥锁（`pg_advisory_lock`）并执行迁移，业务查询和事务走独立连接池（默认 10 个连接）；因此数据库连接应直连或使用 session pooling，不可使用事务池。锁会话断开后所有读写拒绝执行，需由 supervisor 重启。业务进程与 Worker 同实例运行，仍不能横向扩容。

本服务不直接提供 TLS。跨主机访问需经过可信 TLS 反向代理，并限制内部 HTTP 入口和允许的 Host、Origin。`GET /health/live` 检查进程是否响应。`GET /health/ready` 检查数据库，以及开发文件系统模式下的上游 MCP 工具 schema 或生产镜像模式下的镜像调度控制器。`/metrics` 使用独立 Bearer 密钥提供 Prometheus 格式的进程、系统资源、HTTP 和索引队列指标，供内网采集。采集配置、指标口径和查询示例见[运行监控](docs/queue-metrics.md)。

结构化 HTTP 和审计事件输出到 stdout，同时批量写入数据库 `audit_events` 表（代码查询只记录 SHA-256 摘要），管理员可通过 `GET /api/v1/admin/audit` 查询。生产环境仍须配置访问受控的日志采集、留存和告警。`/metrics` 额外暴露 `codeharbor_runtime_fenced{component}`（镜像运行时/图客户端进入 fail-closed 状态时为 1，需人工介入）和 `codeharbor_audit_dropped_total`，应接入告警。

## 管理控制台

服务在 `/ui` 提供同源控制台。飞书登录后可绑定云效 PAT、接入仓库、查看索引进度、创建个人 API Key 和查看 MCP 配置。超级管理员还可查看所有仓库、管理用户和旧 Key、操作仓库启停删除，以及查询全局审计。

超级管理员通过飞书登录后，从「管理 → 运行状态」打开 `/ui/admin/performance`，可查看数据库与索引运行时健康状态，以及当前 CPU、内存、数据目录所在文件系统和服务进程的资源采样。对应接口为 `GET /api/v1/admin/system/performance`。

```sh
npm run install:web   # 安装前端依赖（独立于后端 package.json）
npm run build:web     # 产物输出到 web/dist，服务启动时自动托管
npm run check:web && npm run test:web
```

前端源码在 `web/`（Vite + React + TypeScript + Tailwind），同样使用 Biome 规范；设计 token 见 [design-system/codeharbor-console/MASTER.md](design-system/codeharbor-console/MASTER.md)。开发时 `npm --prefix web run dev` 会把 `/api` 代理到本机 8080 端口的服务。`docker build` 会在独立阶段构建控制台并把产物复制进运行镜像。

控制台使用服务端会话及 HttpOnly Cookie，生产 Cookie 只经 HTTPS 发送。PAT 在登录后的表单提交，浏览器不持久化，服务端加密保存。同源写操作需要匹配公开 Origin。使用模拟飞书和云效本地预览可运行 `npm run test:db:up && npm run build:web && npx tsx scripts/console-preview.ts`。

## 接口文档

开发环境可访问 `/docs` 或 `/openapi.json`。生产默认关闭接口文档，部署模板也限制这些路径。接口的 Cookie 会话、Bearer Key 和 Webhook Token 分别服务于浏览器操作、Agent 和云效推送。健康与监控接口通过受控内网访问。

## 初次登录与使用

1. 打开 `/ui`，使用允许的企业飞书账号登录。
2. 在账号页绑定自己的云效 PAT。令牌应具备用户信息、仓库和分支只读以及 HTTPS Git 克隆所需权限。已有云效账号使用同一账号的 PAT 关联，已归属其他飞书用户的云效账号会拒绝绑定。
3. 接入仓库时选择云效仓库及远程分支，并确认允许使用本人 PAT 自动同步。一次只接入该云效仓库的一个跟踪分支。接入后在仓库详情跟踪排队、拉取、索引、打包和发布阶段。
4. 在「Key」页选择已获准的仓库、范围与有效期。Key 明文仅在创建时显示一次，保存到受保护的凭证库。API Key 和云效 PAT 都只通过各自的授权入口使用。

旧版公开 PAT 引导及 CLI 签发流程已停用。升级前创建的 Key 暂停使用。持有人先登录飞书并绑定原云效账号，超级管理员复核原 Key 已明确限定仓库且仍然有效后，可批准恢复原 Key。无范围或过期的旧 Key 需要重新创建。

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/v1/me` | 当前登录账号与能力 |
| POST | `/api/v1/auth/yunxiao/bind` | 登录后绑定或更新本人 PAT |
| GET | `/api/v1/codeup/repositories?page=1` | 用本人 PAT 查询云效可见仓库 |
| GET | `/api/v1/codeup/repositories/{id}/branches` | 查询云效分支、默认分支与分页 |
| GET / POST | `/api/v1/repositories` | 列出有权查看的已接入仓库或接入仓库 |
| GET | `/api/v1/repositories/{id}` | 仓库索引状态 |
| POST | `/api/v1/repositories/{id}/sync` | 异步更新索引 |
| PUT | `/api/v1/repositories/{id}/sync-credential` | 仓库负责人或同步凭证持有人授权当前 PAT 自动同步 |
| GET | `/api/v1/repositories/{id}/jobs` | 仓库索引任务与进度 |
| GET / POST | `/api/v1/api-keys` | 飞书登录后查看、创建本人 Key |
| DELETE | `/api/v1/api-keys/{prefix}` | 飞书登录后撤销本人 Key |
| POST | `/api/v1/hooks/codeup/{id}` | 云效 Webhook 验证 `X-Codeup-Token` |

接入请求需包含 `codeup_repository_id` 和 `authorize_automatic_sync: true`。省略 `branch` 时使用云效仓库的默认分支。成功响应包含 CodeHarbor 仓库 ID、任务 ID、Webhook 路径和仅返回一次的 Webhook Token。将路径配置到 Codeup Webhook，填写 Token 并选择 Push 事件。无法配置时，可通过手动同步和定期对账更新索引。同步凭证持有人更新 PAT 后，所属仓库进入 `credential_required`，须在详情页重新授权同步。

把 MCP URL `https://<trusted-host>/mcp` 和 `Authorization: Bearer <CodeHarbor Key>` 配置到 Agent。先调用 `list_repositories` 获取 CodeHarbor 的 `repo_id`，再用允许的工具查询源代码。

全部 7 个代码工具保留 CodeGraph 1.6.2 的功能参数，用必填 `repo_id` 替代 `projectPath`：

| 工具 | 参数（除必填 `repo_id` 外） |
| --- | --- |
| `codegraph_search` | 必填 `query`；可选 `kind`、`limit`（1–100） |
| `codegraph_callers` / `codegraph_callees` | 必填 `symbol`；可选 `file`、`limit`（1–100） |
| `codegraph_impact` | 必填 `symbol`；可选 `file`、`depth`（1–10） |
| `codegraph_node` | 至少传 `symbol` 或 `file`；可选 `includeCode`、`offset`、`limit`（1–2000）、`symbolsOnly`、`line` |
| `codegraph_explore` | 必填 `query`；可选 `maxFiles`（1–50） |
| `codegraph_files` | 可选 `path`、`pattern`、`format`（tree/flat/grouped）、`includeMetadata`、`maxDepth`（1–100） |

`codegraph_node` 支持带行号的文件读取和符号详情两种模式。源码来自服务器已发布的 `indexed_commit`，不是客户端本地工作区。`file` / `path` 必须是仓库相对路径，禁止绝对路径、`..` 穿越及客户端 `projectPath`。所有工具共用调用前后鉴权、发布协调、审计、超时/取消和 1 MiB 输出上限。

镜像模式升级时必须重新构建只读基础镜像与仓库查询镜像，不能只更新平台进程。新运行时显式启用 7 个工具并取消显式配置下的小仓库工具隐藏；旧镜像不兼容时查询会拒绝，不会退回无隔离运行。

## 测试

测试全部运行在真实 PostgreSQL 上：每个测试用例创建独立数据库、执行迁移、结束后删除。先用 Docker 启动测试库，再运行测试：

```sh
npm run test:db:up
CODEGRAPH_TEST_BIN="$PWD/node_modules/.bin/codegraph" npm test
npm run test:db:down
```

默认连接 [deploy/compose.test.yaml](deploy/compose.test.yaml) 暴露的 `127.0.0.1:54329`；要使用其他实例，设置 `CODEHARBOR_TEST_DATABASE_URL` 指向一个可创建和删除数据库的账号。测试包括虚拟 Codeup 权限、MCP 隔离、Webhook、任务、迁移与实例锁，以及真实 CodeGraph 多仓库查询。飞书和云效使用模拟服务的测试需另行通过真实企业账号验证。

## 容器

```sh
docker build -t codeharbor:dev .
```

容器以非 root 用户运行。生产部署必须叠加 [镜像 Compose 配置](deploy/compose.image.yaml)，并可选择外部 PostgreSQL 或再叠加 [本地 PostgreSQL Compose 配置](deploy/compose.postgres.yaml)。本地模板使用经验证的 PostgreSQL TLS，外部实例的连接模式由 URL 指定。生产部署需配置 Vault Transit、飞书应用和 HTTPS 反向代理，参见 [部署指南](docs/production-deployment.md)。生产使用前须验证实际云效权限、备份恢复和运行隔离。
