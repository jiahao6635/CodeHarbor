# 平台与内网 MCP 分离部署

此方案在同一台主机运行平台、镜像控制器和独立 MCP 服务。平台继续提供管理 API、索引 Worker 和镜像构建；MCP 服务只监听内网并处理 MCP 请求。公网 Nginx 拒绝 `/mcp`，内部 MCP 服务通过专用 Unix socket 连接平台；MCP 容器不挂载 Docker socket、数据库凭据、Vault 凭据或云效 PAT。仓库镜像仍在本机 Docker 中，不能仅通过复制 MCP 容器将其部署到其他主机。

用户已选择可信内网 HTTP：其他 ECS 的访问地址为 `http://10.29.23.237:18080/mcp`。**Bearer Key、查询和返回的源码内容在网络传输中均为明文**，必须确保该网络和所有中间设备可信，限制访问来源；后续可使用内网 TLS 并让客户端验证证书。网络和安全组规则由运维管理，此模板不会修改阿里云安全组。

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
export CODEHARBOR_MCP_ALLOWED_HOSTS=10.29.23.237:18080
export CODEHARBOR_INTERNAL_MCP_SOCKET_DIR=/path/to/dedicated-mcp-socket-dir
export CODEHARBOR_INTERNAL_MCP_TOKEN_HOST_FILE=/path/to/private-internal-mcp-token
```

`CODEHARBOR_MCP_ALLOWED_HOSTS` 与客户端请求的 HTTP `Host` 严格匹配，默认端口以外的地址要包含端口；如果还需要经过可信代理或健康检查访问，应明确加入相应 Host，多个值以逗号分隔。非浏览器 MCP 客户端一般不发送 `Origin`；浏览器客户端仅在确有需要时设置 `CODEHARBOR_MCP_ALLOWED_ORIGINS`，填入允许的完整 Origin。

执行以下命令前检查合并结果：平台原有非目标挂载、PostgreSQL/Vault/镜像配置必须保留，`nginx.split.conf` 应替换原 Nginx 站点配置，MCP 只发布到指定内网 IP，且无 Docker socket、数据库或 Vault 密钥挂载。若部署使用本机 PostgreSQL，在 `compose.yaml` 与 `compose.image.yaml` 之间加入 `-f deploy/compose.postgres.yaml`；其他现有受控 override 也需在合并后核对。

```sh
docker compose -f deploy/compose.yaml -f deploy/compose.image.yaml -f deploy/compose.split.yaml config
docker compose -f deploy/compose.yaml -f deploy/compose.image.yaml -f deploy/compose.split.yaml up -d --build
```

首次启动或升级时应选择维护窗口，确认平台、镜像控制器和 MCP 都已就绪。内网访问仍使用已有 CodeHarbor Key，通过 `Authorization: Bearer <Key>` 认证；不要把云效 PAT 发给 MCP 客户端。已配置旧公网 MCP 地址的客户端需要迁移到内网地址。

## 验收与回退

- 从另一台有访问权限的 ECS 检查内网地址，使用真实只读 Key 完成 MCP initialize、工具列表和已授权仓库查询；测试错误或已撤销 Key、无权仓库均被拒绝。
- 验证 MCP 内网入口不能调用平台管理 API；检查公网 `https://codegraph.sigmob.com/mcp` 不再提供 MCP，而原有管理 API 和 Swagger 按既有策略可用。
- 验证索引构建期间与完成后 MCP 查询、仓库权限撤销、平台重启和 MCP 重启；平台或内部 socket 不可用时应拒绝请求，不能绕过鉴权。
- 验证应用和 MCP 容器日志不包含 Bearer、内部 token 或查询源码；检查实际发布端口仅绑定目标内网 IP。`/health/ready` 不能替代一次实际仓库查询。

如需回退，按原部署命令恢复之前的 Compose 组合和 Nginx 配置，并核对实际平台版本和监听端口。不要删除 PostgreSQL、Vault、镜像控制器状态或仓库镜像；回退前应通知使用新内网地址的客户端。公网 MCP 是否重新开放须由部署决策明确确认。

独立 MCP 进程输出不包含令牌或查询内容的结构化 HTTP 访问日志；平台继续记录 MCP 工具审计。MCP 进程的 HTTP 请求不计入平台 `/metrics` 的 HTTP 请求数和耗时，需要独立采集日志或后续增加指标。
