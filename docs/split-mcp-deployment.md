# 平台与内网 MCP 分离部署

此方案在同一台主机运行平台、镜像控制器和独立 MCP 服务。平台继续提供管理 API、索引 Worker 和镜像构建；MCP 服务只处理 MCP 请求。平台自身的 `/mcp` 始终关闭（`CODEHARBOR_PUBLIC_MCP_DISABLED=true`），Nginx 把 `/mcp` 转发给独立 MCP 服务；内部 MCP 服务通过专用 Unix socket 连接平台；MCP 容器不挂载 Docker socket、数据库凭据、Vault 凭据或云效 PAT。仓库镜像仍在本机 Docker 中，不能仅通过复制 MCP 容器将其部署到其他主机。

当前部署的 `codegraph.sigmob.com` 仅内网可达，MCP 的推荐地址为 `https://codegraph.sigmob.com/mcp`，与控制台同域、经 Nginx TLS。**只有在该域名仅对可信网络开放时才能使用此配置**；若域名可从公网访问，须先在 Nginx 的 `/mcp` 上限制来源 IP，或恢复为 `return 404` 只保留内网端口。

内网端口 `http://10.29.23.237:18080/mcp` 继续保留，供尚未迁移的客户端使用；该端口由 Nginx 执行来源限流后转发，MCP 容器本身不再向宿主机发布端口。**该端口上 Bearer Key、查询和返回的源码内容在网络传输中均为明文**，必须确保该网络和所有中间设备可信，限制访问来源；客户端迁移完成后可关闭该端口。网络和安全组规则由运维管理，此模板不会修改阿里云安全组。

## 前提

1. 已按 [镜像模式部署指南](image-deployment.md) 准备 PostgreSQL、Vault、镜像控制器、运行时镜像、各自密钥和 socket 目录，并保留现有可恢复的配置和备份。
2. 在目标主机验证 `10.29.23.237` 确实配置在本机内网网卡上，其他 ECS 可路由到该 IP；由运维确认来源到 TCP 18080 的访问策略。不要将监听地址设置为 `0.0.0.0` 或公网 IP。可以更换为实际指定的私网 IP，但必须同步修改允许的 Host。
3. 由运维创建一个**专用且此前不存在**的宿主机目录，所属 UID/GID 为 `1000:1000`，权限为 `0700`，并保证其父目录不允许不可信用户替换或写入。平台和 MCP 共享此目录；平台以 UID 1000 创建权限为 `0600` 的 socket，MCP 以同一 UID 只读挂载目录并连接 socket。不要复用现有控制器或授权 socket 目录，也不要把目录开放给其他容器或用户。
4. 独立生成一个内部 MCP token，至少 32 字节随机值，放入仅平台和 MCP 运行用户可读的受保护文件。该 token 必须与 CodeHarbor API Key、监控 token、镜像查询/构建/授权 token 及其他服务密钥不同；不要将密钥内容放入环境变量、源码、命令行或日志。Compose 本地文件 secret 沿用宿主文件权限，须检查 UID 1000 可读。

## 配置与启动

在已有镜像模式配置的基础上设置以下**非密钥值**，其中目录和 token 文件路径替换为运维实际准备的位置：

```sh
export CODEHARBOR_MCP_LISTEN_ADDR=10.29.23.237
export CODEHARBOR_MCP_LISTEN_PORT=18080
# 内网端口与经 Nginx 转发的控制台域名（Nginx 传递不带端口的 $host）
export CODEHARBOR_MCP_ALLOWED_HOSTS=10.29.23.237:18080,codegraph.sigmob.com
export CODEHARBOR_INTERNAL_MCP_SOCKET_DIR=/path/to/dedicated-mcp-socket-dir
export CODEHARBOR_INTERNAL_MCP_TOKEN_HOST_FILE=/path/to/private-internal-mcp-token
# 控制台「MCP 接入」页展示的地址；与控制台同域时页面不再提示“单独地址”
export CODEHARBOR_UI_MCP_URL=https://codegraph.sigmob.com/mcp
```

`CODEHARBOR_MCP_ALLOWED_HOSTS` 与客户端请求的 HTTP `Host` 严格匹配，默认端口以外的地址要包含端口；如果还需要经过可信代理或健康检查访问，应明确加入相应 Host，多个值以逗号分隔。非浏览器 MCP 客户端一般不发送 `Origin`；浏览器客户端仅在确有需要时设置 `CODEHARBOR_MCP_ALLOWED_ORIGINS`，填入允许的完整 Origin。

独立 MCP 服务会在自身入口执行容量保护，直连内网端口不会绕过这些控制。Nginx 会覆盖转发的客户端地址头，服务仅在这个内部拓扑中信任该值。每个 Key 的请求配额和每个客户端地址的认证失败配额分别沿用 `CODEHARBOR_MCP_KEY_RATE_PER_MIN`（默认 `120`）与 `CODEHARBOR_AUTH_FAILURE_RATE_PER_MIN`（默认 `30`）；单个 Key 同时最多执行 2 个查询，服务同时最多处理 32 个后端请求。`/health/ready` 每个来源每分钟最多请求 30 次，并按 `CODEHARBOR_MCP_READY_CACHE_MS`（默认 `5000` 毫秒）缓存探测结果，使并发或高频检查不会重复占用数据库和 CodeGraph 探测容量；`/health/live` 仍只检查进程存活且不调用后端。

镜像查询并发通过 `CODEHARBOR_MCP_QUERY_CONCURRENCY` 控制，默认 `10`、可配置 `1`～`32` 的整数。平台和镜像控制器必须使用同一个值；`compose.image.yaml` 会将该变量同时传给两者，独立 MCP 网关无需单独配置。上线时同时更新平台和控制器，并按实际负载验证 CPU、内存和等待时间。

执行以下命令前检查合并结果：平台原有非目标挂载、PostgreSQL/Vault/镜像配置必须保留，`nginx.split.conf` 应替换原 Nginx 站点配置，MCP 只发布到指定内网 IP，且无 Docker socket、数据库或 Vault 密钥挂载。若部署使用本机 PostgreSQL，在 `compose.yaml` 与 `compose.image.yaml` 之间加入 `-f deploy/compose.postgres.yaml`；其他现有受控 override 也需在合并后核对。

```sh
docker compose -f deploy/compose.yaml -f deploy/compose.image.yaml -f deploy/compose.split.yaml config
docker compose -f deploy/compose.yaml -f deploy/compose.image.yaml -f deploy/compose.split.yaml up -d --build
```

首次启动或升级时应选择维护窗口，确认平台、镜像控制器和 MCP 都已就绪。MCP 访问仍使用已有 CodeHarbor Key，通过 `Authorization: Bearer <Key>` 认证；不要把云效 PAT 发给 MCP 客户端。使用 `18080` 端口的客户端可改为 `https://codegraph.sigmob.com/mcp`；若客户端不信任站点证书，需先安装对应 CA。

MCP 查询需要有效且 `repos` 明确包含目标仓库 ID 的 Key；旧 `repos: null` Key 不自动获得所有仓库的代码读取权。管理员应为使用者签发限定仓库范围的 Key。查询不再实时核验云效权限，云效撤权或 PAT 失效时已有 Key 仍可读取其范围内的旧索引，必须通过 CodeHarbor 撤销或替换 Key 收回访问；接入和同步仍使用对应授权 PAT。

管理员代发 Key 时，当前接口不能指定目标用户，Key 的 owner 和审计主体仍为签发者，仅可用 Key 前缀区分。普通用户的 `repos: null` 初始 read Key 不能自己派生限定范围的 Key；Key 分发与实际使用者识别需通过受控的企业流程处理。

## 验收与回退

- 分别通过 `https://codegraph.sigmob.com/mcp` 和内网端口，使用真实只读 Key 完成 MCP initialize、工具列表和已授权仓库查询；测试错误或已撤销 Key、无权仓库均被拒绝。
- 验证 MCP 入口不能调用平台管理 API：`/mcp/` 子路径返回 404，平台进程自身的 `/mcp` 保持关闭；原有管理 API 和 Swagger 按既有策略可用。
- 验证索引构建期间与完成后 MCP 查询、CodeHarbor Key 撤销、平台重启和 MCP 重启；平台或内部 socket 不可用时应拒绝请求，不能绕过鉴权。另确认云效撤权不会自动撤销 Key，并按企业流程及时撤销对应 CodeHarbor Key。
- 验证应用和 MCP 容器日志不包含 Bearer、内部 token 或查询源码；检查实际发布端口仅绑定目标内网 IP。`/health/ready` 不能替代一次实际仓库查询。

如需回退，按原部署命令恢复之前的 Compose 组合和 Nginx 配置，并核对实际平台版本和监听端口。不要删除 PostgreSQL、Vault、镜像控制器状态或仓库镜像；回退前应通知使用域名地址的客户端改回内网端口。域名是否开放到公网须由部署决策明确确认，开放前须先关闭或限制 `/mcp`。

独立 MCP 进程输出不包含令牌或查询内容的结构化 HTTP 访问日志；平台继续记录 MCP 工具审计。MCP 进程的 HTTP 请求不计入平台 `/metrics` 的 HTTP 请求数和耗时，需要独立采集日志或后续增加指标。
