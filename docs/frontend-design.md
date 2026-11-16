# CodeHarbor 管理控制台前端设计方案

- 状态：已实施（2026-11-16），代码在 `web/`，后端配套改动已合入 `src/`；本文为设计记录
- 日期：2026-11-16
- 范围：自助控制台 + 管理后台全覆盖
- 技术栈：Vite + React + TypeScript + shadcn/ui（Tailwind 4），构建产物由 Fastify 以 `/ui` 路径同源托管
- 设计系统：[design-system/codeharbor-console/MASTER.md](../design-system/codeharbor-console/MASTER.md)（ui-ux-pro-max 生成并修订）

## 1. 背景与目标

CodeHarbor 目前只有后端接口。[手动接入指南](manual-clean-start.md) 让非技术用户直接在 Swagger 页面上完成绑定云效、接入仓库、创建密钥等操作，存在几个问题：

- Swagger 会把 PAT、密钥回显在请求框和生成的 `curl` 命令里，容易被截图、误粘贴；
- 仓库状态、任务进度需要反复手动执行 `GET` 查询，没有轮询和状态解释；
- `token`、`webhook_token` 只返回一次，Swagger 没有"只展示一次并要求确认已保存"的保护；
- 生产环境 Nginx 已经屏蔽 `/docs`，管理员实际上只能用 CLI 或 Postman 操作。

目标是提供一个面向普通使用者和平台管理员的控制台，把现有 REST API 的完整流程做成可用界面，**不新增业务能力、不扩大后端权限模型**，只在必要处补充少量只读或便利性接口。

### 1.1 不在范围内

- 浏览器端直接查询代码（MCP 查询仍由 Agent / MCP 客户端完成；管理 Key 本身也不能查询代码）。
- 飞书 / SSO 登录。身份仍由云效 PAT 绑定与 CodeHarbor Key 承担。
- 替代 CLI。CLI 继续作为在可信终端绑定 PAT 的推荐方式。
- 多语言。一期只做中文。

## 2. 角色与权限

控制台不引入新的角色体系，页面能力完全由登录所用 Key 的类型推导（与 `src/authorization.ts` 一致）：

| Key 类型 | 判定 | 可用页面 |
|---|---|---|
| 自助 read Key | `scope=read`，`repos=null` | 仓库列表（按本人云效权限）、仓库详情、本人 Key、MCP 接入指引 |
| 限定范围 read Key | `scope=read`，`repos=[...]` | 仅列出的仓库；Key 页只能看到并撤销自己 |
| write Key（非管理员用户） | `scope=write` 但用户不在 `CODEHARBOR_WRITE_USERS` | 与 read 相同（后端 `requireWrite` 会拒绝写操作，前端应直接隐藏入口） |
| 管理 Key | `scope=write`，`repos=null`，用户在 `CODEHARBOR_WRITE_USERS` | 全部页面：接入仓库、同步、创建下级 Key、管理后台 |

前端只做入口显隐，所有权限仍由后端判定；收到 403 时提示"当前 Key 无此权限"。

## 3. 信息架构

```
/ui
├── /login                  输入 CodeHarbor Key 登录
├── /onboarding             首次使用向导：绑定 PAT → 领取 Key
├── /repositories           仓库列表（默认首页）
│   ├── /new                接入云效仓库（需管理 Key）
│   └── /:id                仓库详情：状态、任务历史、操作
├── /keys                   本人 Key 管理
├── /mcp                    MCP 接入指引
└── /admin                  管理后台（仅管理 Key 可见）
    ├── /repositories       全部仓库（含已禁用）：禁用 / 启用 / 删除
    ├── /users              已绑定用户、一键撤销其全部 Key
    ├── /keys               全平台 Key 列表、按 owner 筛选、撤销
    └── /audit              审计事件查询
```

布局：左侧导航 + 顶部状态栏（当前用户名、Key 前缀、scope、到期时间、退出）。管理后台作为导航中的独立分组，非管理员不渲染。

## 4. 页面设计

### 4.1 登录 `/login`

- 单个输入框粘贴 CodeHarbor Key，点击登录后调用 `GET /api/v1/me` 验证。
- 成功后 Key 保存在 `sessionStorage`（关闭标签页即清除），不提供"记住我"。
- 失败提示区分 401（Key 无效/过期/已撤销）与 429（认证失败过多，稍后再试）。
- 页面底部提供"还没有 Key？首次绑定"入口跳转向导。

### 4.2 首次绑定向导 `/onboarding`

三步向导，对应 `docs/manual-clean-start.md` 前两步：

1. **绑定云效账号**：输入 PAT（密码框，仅存组件状态，提交后立即清空）→ `POST /api/v1/auth/yunxiao/bind`。展示返回的用户名；`bootstrap_token` 只保存在内存，页面提示"5 分钟内有效，刷新页面需重新绑定"。错误映射：`INVALID_CREDENTIAL` → PAT 无效或缺少权限；`CODEUP_UNAVAILABLE` → 云效不可达；429 → 绑定过于频繁。
2. **申请 Key**：选择 `read`（默认）或 `write`（说明需管理员预先将用户加入 `CODEHARBOR_WRITE_USERS`，否则 403），选择有效期（7/30/90 天，上限 90 天）→ `POST /api/v1/auth/bootstrap/keys`。
3. **保存 Key**：以"仅显示一次"弹窗展示 `token`，提供复制按钮，必须勾选"我已妥善保存"才能关闭；关闭后自动用该 Key 登录并进入仓库列表。

页面顶部固定提示：建议在可信设备、HTTPS 地址下操作；重新绑定 PAT 会使本人同步的仓库进入 `credential_required`，需要在仓库详情页重新授权。

### 4.3 仓库列表 `/repositories`

- 数据源 `GET /api/v1/repositories`，表格列：名称、分支、状态徽章、索引 commit（短 SHA）、索引时间（相对时间 + 悬停绝对时间）、`stale` 标记、错误码。
- 存在非终态仓库（`pending` / `indexing` / `updating`）时每 10 秒轮询，否则不轮询；页面不可见时暂停。
- 管理 Key 显示"接入仓库"按钮；行内操作"同步"（`POST /:id/sync`，需 write）。
- 搜索框按名称 / 分支前端过滤；支持按状态筛选。

状态徽章设计（与 worker 状态一致）：

| 状态 | 颜色 | 说明文案 |
|---|---|---|
| `ready` | 绿 | 索引可用 |
| `pending` | 灰 | 等待首次构建 |
| `indexing` / `updating` | 蓝（带加载动画） | 构建中 / 更新中，保留上次索引 |
| `credential_required` | 橙 | 需要重新授权同步凭证 |
| `branch_deleted` | 橙 | 远端分支已删除 |
| `failed` | 红 | 构建失败，展示 `error` |
| `disabled` | 灰（仅管理后台可见） | 已禁用 |

### 4.4 接入仓库 `/repositories/new`（管理 Key）

两种方式切换：

- **从云效列表选择**：`GET /api/v1/codeup/repositories?page=N` 分页加载，展示名称 / 路径 / 访问级别，支持关键字过滤；点击选中后填充 ID。
- **直接输入云效仓库 ID**：数字输入，校验 `^\d{1,30}$`。

公共字段：分支（默认 `main`，前端复用后端的禁止字符规则做即时校验）、必选勾选"授权平台使用我当前的 PAT 自动同步该仓库"（对应 `authorize_automatic_sync: true`）。

提交 `POST /api/v1/repositories`：

- 202：弹出"仅显示一次"面板，展示 `webhook_path` 和 `webhook_token`，附带 Codeup Webhook 配置步骤（完整 URL = 当前站点 origin + path，事件选 Push，Secret Token 填 token），并给出"稍后查看任务进度"跳转到详情页。
- 200（仓库已存在）：提示并跳转详情页。
- 404：云效仓库不存在、无权限或无法克隆；403：Key 无写权限。

### 4.5 仓库详情 `/repositories/:id`

- 状态卡：名称、云效 ID、分支、状态、索引 commit、索引时间、错误码及中文解释、Webhook 路径（token 不再显示）。
- 任务历史：依赖新增接口 `GET /api/v1/repositories/:id/jobs`（见第 7 节），列出 `reason`（initial / manual / webhook / credential_changed / reconcile）、状态、排队时间、完成时间、构建耗时、错误；有 `queued` / `running` 任务时每 5 秒轮询 `GET /api/v1/jobs/:id`。
- 操作区（按权限显隐）：
  - 同步：`POST /:id/sync`，提示返回的 `job_id` 并开始轮询；
  - 重新授权同步凭证：仅当状态为 `credential_required` 且当前用户是仓库 owner 或 sync_owner 时显示，`PUT /:id/sync-credential`；
  - 禁用 / 启用 / 删除：仅管理 Key；删除仅在 `disabled` 时可点，二次确认需输入仓库名。

### 4.6 Key 管理 `/keys`

- `GET /api/v1/api-keys` 列表：前缀、scope、仓库范围（`null` 显示"跟随云效权限"或"平台管理"）、到期时间、是否撤销。
- 创建下级 Key（write Key 可见）：scope 单选；`read` 必须选择仓库范围（多选，从本人可见仓库列表取，最多 100）；有效期不得超过当前 Key 的剩余有效期（前端用 `/me` 返回的 `expires_at` 预校验）。成功后同样走"仅显示一次"弹窗。
- 撤销：`DELETE /api/v1/api-keys/:prefix`，撤销当前登录 Key 时弹出特别提示并在成功后强制登出。

### 4.7 MCP 接入指引 `/mcp`

静态页面，根据当前站点 origin 生成 MCP URL（可由配置覆盖为内网地址），提供 Claude / Cursor / Qoder 等客户端的配置片段模板，占位 `<CodeHarbor Key>` 由用户自行填写，页面不回填 Key。说明管理 Key 不能查询代码。

### 4.8 管理后台 `/admin/*`

- **仓库**：依赖新增接口 `GET /api/v1/admin/repositories`（含 `disabled`、owner、sync_owner）。现有 `GET /api/v1/repositories` 会过滤掉已禁用仓库，管理员无法通过它找到需要启用或删除的仓库。
- **用户**：`GET /api/v1/admin/users`，展示 id、username、credential_version；操作"撤销该用户全部 Key"（`POST /admin/users/:id/revoke-keys`，二次确认）。
- **Key**：`GET /api/v1/admin/api-keys?owner=&page=`，按 owner 筛选、分页；撤销 `DELETE /admin/api-keys/:prefix`，409 时提示前缀冲突需用 CLI 处理。
- **审计**：`GET /api/v1/admin/audit?subject=&repo_id=&since=&limit=`，筛选表单 + 表格（时间、方法、路由、状态码、认证方式、主体、Key 前缀、仓库、工具、结果、查询摘要）。只读，不做导出（审计内容已在数据库，导出走 DBA 流程）。

## 5. 认证与安全设计

1. **Key 存储**：仅 `sessionStorage`，不落 `localStorage`、不写 Cookie；登出或 401 时清除。所有请求通过统一 `apiFetch` 注入 `Authorization: Bearer`。
2. **PAT**：只存在于向导组件状态，提交后置空；不进入全局 store、日志或 URL。
3. **只显示一次的秘密**（Key token、bootstrap token、webhook token）：统一 `SecretReveal` 组件，默认遮罩、复制按钮、必须确认后关闭，不写入任何持久化存储。
4. **同源与 Origin 白名单**：UI 由同一 Fastify 进程以 `/ui` 托管，避免跨域。注意浏览器对同源的 `POST/PUT/DELETE` 也会发送 `Origin` 头，而 `src/server.ts` 的 onRequest 钩子会拒绝不在 `CODEHARBOR_ALLOWED_ORIGINS` 中的 Origin，因此部署时必须把站点 origin 加入该变量；建议同时在后端放行"Origin 与 `X-Forwarded-Proto` + Host 完全相同"的同源请求，减少配置错误。
5. **CSP**：`/ui` 响应头 `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`。不使用 CDN，所有依赖打包进产物。Vite 产物无内联脚本。
6. **缓存**：`/ui/index.html` 为 `no-store`，带 hash 的静态资源可 `max-age=31536000, immutable`。现有钩子对非 `/docs` 路径统一设 `no-store`，需为 `/ui/assets/*` 放开。
7. **错误处理**：后端只返回固定错误码（`src/http/errors.ts`），前端维护错误码 → 中文说明映射表；未知码显示原始码和 `x-request-id`，便于查日志。
8. **限流感知**：401 累积会触发按 IP 的认证失败限流（默认 30/min），登录页对 429 显示冷却提示并禁用按钮 60 秒；绑定接口每 IP 10/min 同理。
9. **不新增后端写能力**：前端只调用已有接口；新增接口均为只读（第 7 节）。

## 6. 技术方案

### 6.1 目录与构建

```
web/
├── package.json          独立依赖，不污染后端 package.json
├── vite.config.ts        base: '/ui/'，build.outDir: '../dist/ui'（或 web/dist 再由后端引用）
├── tsconfig.json
├── biome.json            继承根 biome.json（120 列、单引号）
├── index.html
└── src/
    ├── main.tsx
    ├── styles/           tokens.css（MASTER.md 的 CSS 变量，含 dark/light）、fonts.css、globals.css（Tailwind @theme）
    ├── app/              路由、布局（AppShell / Sidebar / TopBar）、Providers
    ├── api/              client.ts（fetch 封装）、types.ts（按 openapi.ts 手写或生成）、各资源 hooks
    ├── auth/             session 管理、权限推导（isAdmin / canWrite）
    ├── pages/            按第 3 节路由分目录
    ├── components/ui/    shadcn 生成的基础组件
    ├── components/       StatusBadge、SecretReveal、ConfirmDialog、DataTable、EmptyState、RelativeTime、CopyButton
    └── lib/              错误码映射、时间格式化、branch 校验
```

根 `package.json` 增加脚本：`build:web`（`npm --prefix web run build`）、`check:web`；`npm run build` 顺序执行后端与前端构建。CI 和 Dockerfile 改为多阶段：第一阶段构建 `web/dist`，第二阶段只拷贝产物，不把前端 devDependencies 带入运行镜像。

### 6.2 依赖选择

| 用途 | 选择 | 理由 |
|---|---|---|
| UI 组件 | shadcn/ui（Radix 原语 + Tailwind 4） | 组件源码进仓库、无运行时主题层，`--color-primary / --color-card / --color-ring` 等变量与第 10 节设计系统的 token 命名一一对应；无外部资源，满足 CSP |
| 表格 | TanStack Table 8 + shadcn `Table` | 排序、筛选、列定义类型安全；密度 8 的紧凑行高可控 |
| 图标 | Phosphor Icons（`@phosphor-icons/react`，regular） | 单一图标族，outline 风格与 Swiss 极简一致 |
| 字体 | `@fontsource-variable/inter`、`@fontsource/fira-code` | 自托管打包，不走 Google Fonts CDN |
| 路由 | react-router 7 | 标准方案，支持嵌套布局与守卫 |
| 数据请求 | TanStack Query 5 | 轮询（`refetchInterval` 按数据动态决定）、缓存失效、页面不可见时暂停 |
| 表单 | react-hook-form + zod | 行内校验与后端 `validation.ts` 规则一致，错误通过 `aria-describedby` 关联字段 |
| 时间 | dayjs | 相对时间展示 |
| 通知 | sonner | 轻量 toast，支持持久化错误提示 |

不引入全局状态库与动画库（GSAP / framer-motion）；登录态用 React Context + `sessionStorage`，动效仅用 CSS transition。

Ant Design 曾作为备选：组件更全但自带视觉体系，与 token 化设计系统冲突，且产物体积大，故不采用。

### 6.3 API 层

- `apiFetch(path, init)`：注入 Bearer、`Accept: application/json`、处理 401（清除会话跳转登录）、429、非 JSON 响应；返回 `{ data } | { error, status, requestId }`。
- 类型来源：`src/openapi.ts` 已有完整 OpenAPI 定义，可在构建前用 `openapi-typescript` 生成 `web/src/api/schema.d.ts`，避免前后端类型漂移。
- 轮询策略：列表页 10 秒（有非终态仓库时），详情页任务 5 秒，页面隐藏时停止；手动操作后立即 `invalidate`。

### 6.4 后端托管

- 新增 `CODEHARBOR_UI_ENABLED`（默认开发 `true`，生产由部署决定），启用时注册 `@fastify/static` 服务 `dist/ui`，`/ui` 与 `/ui/*` 未命中文件时回退 `index.html`。
- `/ui` 不受 `AUDITED_ROUTE` 审计（静态资源），不计入 MCP 指标。
- Nginx：`/ui` 走现有 `location /`；`/docs`、`/openapi.json` 继续屏蔽。若希望公网只开放控制台而不开放 API 调试，无需额外改动。

## 7. 需要配套的后端改动

均为小改动，建议与前端一期一起提交，并同步更新 `src/openapi.ts` 与测试：

| # | 改动 | 原因 |
|---|---|---|
| 1 | `@fastify/static` 托管 `/ui`，SPA 回退，CSP 与缓存头 | 同源部署 |
| 2 | `GET /api/v1/me` 增加 `is_admin`、`can_write`、`key_prefix`、`key_repos`、`key_expires_at` | 前端需要推导页面权限与创建下级 Key 的有效期上限；目前只返回 `key_scope` |
| 3 | 新增 `GET /api/v1/admin/repositories`（含 disabled，返回 owner / sync_owner / codeup_id） | 现有列表过滤掉 disabled，管理员无法启用或删除 |
| 4 | 新增 `GET /api/v1/repositories/:id/jobs` | `store.listJobs` 已存在但未暴露；详情页需要任务历史 |
| 5 | onRequest 钩子放行同源 Origin（Origin == `${X-Forwarded-Proto|http}://${Host}`） | 降低 `CODEHARBOR_ALLOWED_ORIGINS` 配置错误导致控制台全部 403 的风险，可选 |
| 6 | `publicRepository` 增加 `codeup_id` 与 `webhook_path` | 详情页展示与 Webhook 配置指引 |
| 7 | Dockerfile 多阶段构建、`npm run build:web` 独立脚本 | 发布 |

实施补充：新增 `GET /api/v1/console`（需认证）返回 `mcp_url` 与 `public_mcp_disabled`，供 MCP 指引页使用；新增环境变量 `CODEHARBOR_UI_ENABLED`、`CODEHARBOR_UI_DIR`、`CODEHARBOR_UI_MCP_URL`；Vite 构建关闭资源内联（`assetsInlineLimit: 0`），否则小体积字体会被内联为 `data:` URI 并被 CSP 拦截。

不改动权限模型、Key 签发规则和 MCP 路由。

## 8. 实施计划

| 阶段 | 内容 | 产出 |
|---|---|---|
| 0 | 后端改动 #1–#7，openapi 与测试更新 | 可被前端消费的接口；`/ui` 返回占位页 |
| 1 | 脚手架：web/ 初始化、布局、登录、`/me` 守卫、API 层、错误码映射、SecretReveal | 能登录并看到空壳页面 |
| 2 | 自助流程：绑定向导、仓库列表、仓库详情（含轮询）、Key 管理、MCP 指引 | 普通用户可完全脱离 Swagger |
| 3 | 管理流程：接入仓库、管理后台四个页面 | 管理员可完全脱离 Swagger / Postman |
| 4 | 验证：Playwright 端到端用例（登录、向导、接入、同步、撤销 Key）、Biome / tsc、构建进 Docker 镜像、更新 `manual-clean-start.md` 改为控制台操作 | 可发布版本 |

每阶段结束跑 `npm run check` 和前端 `check:web`；阶段 2 起用真实测试库跑现有后端测试确保接口改动未破坏行为。

## 9. 已确认与待确认事项

已确认：

- 公网域名下允许在浏览器中走绑定向导（输入 PAT）。向导页保留可信设备与 HTTPS 提示，PAT 仅存组件状态；`/api/v1/auth/` 继续受 Nginx 每 IP 1r/s 与应用层每 IP 10/min 限流保护。
- 视觉与交互按 ui-ux-pro-max 设计系统执行（第 10 节），组件库选用 shadcn/ui。
- MCP 指引页地址通过 `CODEHARBOR_UI_MCP_URL` 配置，未配置时回退为页面 origin + `/mcp`。

待确认：

1. 审计页是否需要导出 CSV；一期未做。
2. 端到端用例目前是 `scripts/console-preview.ts` + 本地 Playwright 走查脚本，尚未纳入 CI；是否要把走查脚本正式化为仓库内的 e2e 测试。

## 10. 视觉与交互设计

设计系统由 ui-ux-pro-max 生成并按项目约束修订，完整 token、组件规格与交付检查清单见 [design-system/codeharbor-console/MASTER.md](../design-system/codeharbor-console/MASTER.md)；实现任一页面前先读该文件，页面级覆盖放在 `design-system/codeharbor-console/pages/<page>.md`。本节只记录结论与理由。

### 10.1 方向

- 产品类型匹配 **Developer Tool / API Developer Portal**，风格采用 **Minimalism & Swiss Style**：高对比、网格布局、无装饰、功能优先。设计拨盘：Variance 2（居中、克制）、Motion 2（仅微交互）、Density 8（后台密度，间距 2–32px）。
- **深色为默认主题**（开发者工具类别推荐），浅色主题通过同名 token 切换，顶部栏提供开关并记在 `localStorage`。
- 配色为 slate 系深色底 + 绿色 CTA（"Code dark + run green"）；浅色主题 CTA 改为 green-700 以保证白字 4.5:1 对比。状态色单独定义五组语义 token（ready / progress / pending / warning / error），徽章用 15% 底色 + 同色文字 + 图标 + 文案，不靠颜色单独传达状态。
- 字体 Inter（界面）+ Fira Code（commit SHA、Key 前缀、token、路径、JSON 片段），通过 `@fontsource` 打包自托管；中文回退系统字体。基准 16px，行高 1.5，表格 14px，辅助信息 12px 不用于正文。
- 图标统一 Phosphor regular，表格 16px、导航与按钮 20px；装饰图标 `aria-hidden`，纯图标按钮必须有 `aria-label`。

### 10.2 应用外壳

- 左侧栏 240px（1024px 以下收为 56px 图标栏，768px 以下为抽屉）+ 48px 顶栏 + 内容区最大 1280px、内边距 24px。
- 导航分两组：仓库 / Key / MCP 接入；管理（仅管理 Key 渲染）：仓库 / 用户 / Key / 审计。当前项左侧 2px 强调条 + muted 底色，层级不超过两级。
- 页面模板：`h1` 标题 + 一行说明 + 右上主操作；筛选工具条；内容区。每页只有一个 `h1`，标题层级顺序递进。
- 详情页用面包屑（仓库 > 名称）；其他页面不用。

### 10.3 关键交互规则

| 场景 | 规则 | 依据（ux 指南） |
|---|---|---|
| 表单错误 | 每个无效字段下方显示具体错误并用 `aria-describedby` 关联；提交失败时顶部出现可聚焦的错误摘要并把焦点移过去，摘要条目链接到字段 | Error Placement / Focusable Error Summary |
| 秘密输入 | PAT、Key 输入框 `type=password` + 显示/隐藏切换，`autocomplete=off` | Password Visibility |
| 秘密展示 | 统一 SecretReveal 对话框：默认遮罩、复制按钮带"已复制"反馈、勾选"我已妥善保存"后才允许关闭，Esc 与遮罩点击不关闭 | Confirmation Dialogs / Confirmation Messages |
| 破坏性操作 | 删除仓库、撤销 Key、撤销用户全部 Key 均需确认对话框；删除需输入仓库名；焦点默认落在"取消" | Confirmation Dialogs |
| 异步状态 | 轮询引起的状态变化通过单一 `role="status" aria-atomic` 区域播报（如"索引状态：构建中"），不移动焦点 | Contextual Live Badge Updates |
| 提交反馈 | 按钮进入 loading（`aria-busy`）→ 成功 toast 4s 自动消失 / 错误 toast 持久并附可复制的 `x-request-id` | Submit Feedback |
| 表格 | 行高 40px，表头吸顶，`overflow-x: auto`；768px 以下仓库与 Key 列表切换为卡片列表；加载用等高骨架避免布局跳动，已有数据时的刷新只显示顶部细进度条 | Table Handling |
| 空状态 | 图标 + 一句话 + 唯一的主操作（如"接入第一个仓库"） | — |
| 动效 | 仅 CSS transition：悬停 150ms，对话框进 200ms / 出 150ms，徽章变色 200ms；`prefers-reduced-motion` 下关闭旋转与骨架闪烁；不做行悬停位移、不做滚动揭示 | Animation 优先级 7 |
| 触控 | 可点击元素最小命中区 44×44px（表格行内 32px 按钮通过外边距补足），间距 ≥ 8px | Touch & Interaction |

### 10.4 页面级要点

- **登录**：居中单列 400px，Logo + 标题 + Key 输入 + 登录按钮 + "首次绑定"链接；429 时按钮禁用并显示 60s 倒计时。
- **绑定向导**：560px 单列，顶部三步 Stepper，每步只做一件事；第三步直接复用 SecretReveal，关闭后自动登录。
- **仓库列表**：工具条（搜索、状态筛选、接入按钮），表格列 名称 / 分支 / 状态 / commit（mono，7 位）/ 索引时间（相对时间，悬停绝对值）/ 操作；存在进行中仓库时右上角显示"自动刷新中"小提示。
- **仓库详情**：上方状态卡（名称 + 状态徽章 + 定义列表），中间操作条（按权限显隐），下方任务历史表格；`credential_required` 时在状态卡下方给出橙色说明条与"重新授权"主操作。
- **Key 管理 / 管理后台**：同一表格模板；撤销当前登录 Key 的确认框额外提示"操作后将退出登录"。
- **MCP 指引**：代码块使用 Fira Code，每段配置有复制按钮，`<CodeHarbor Key>` 占位符高亮且不自动填充。

### 10.5 交付检查

按 MASTER.md 的 Pre-Delivery Checklist 执行；此外在 CI 中加入：`grep -r "https://" dist/ui/assets` 仅允许文档链接，`npm --prefix web run check` 包含 Biome 与 tsc，Playwright 用例覆盖键盘完成登录与向导、对话框焦点陷阱、375px 下无横向滚动。
