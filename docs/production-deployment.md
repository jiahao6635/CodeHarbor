# CodeHarbor 单实例部署指南

本文描述部署模板和上线前验证；尚未对公司的云效、PostgreSQL、Vault、网络和权限策略完成联调。不要将模板当作已上线或多实例方案。

## 架构与限制

- CodeHarbor 使用 Fastify、官方 MCP SDK、CodeGraph 1.6.2 和 PostgreSQL；API、MCP 和索引 Worker 在同一进程中。每个仓库的 CodeGraph SQLite 索引与工作树存放在持久化磁盘。
- PostgreSQL 连接持有 session advisory lock，同一数据库只允许一个 CodeHarbor 实例。连接断开时拒绝后续数据库操作；使用 supervisor 监控并重启。仅支持直连或 session pooling，禁止使用事务池模式。
- PAT 使用 AES-256-GCM 加密，主密钥通过 Vault Transit 保护；启动时 Vault 解包主密钥到应用内存。详见 [Vault Transit 指南](vault-transit.md)。
- 本模板没有跨实例任务租约、fencing、共享索引协调或高可用；不应增加副本。索引 Worker 与 API 共用容器，容器边界无法提供仓库间强隔离。未验证企业云效权限之前不能认为可以用于生产多租户。
- Nginx 对外提供 TLS，不公开 `/health/` 或 `/metrics`；指标通过受控内网及独立 Bearer 访问应用端口。按企业网关、告警和日志平台调整。

## 前提

1. PostgreSQL 17 可以使用远端现有实例，也可以按下文启动本机 Docker 实例。应用账户须能建表和使用 advisory lock。两种方式均须配置服务端证书和可信 CA，连接串必须为 `postgresql://...?...sslmode=verify-full`；生产环境拒绝额外连接参数（可选 `application_name` 除外），不得关闭 TLS 校验。数据库必须持久化、备份并限制访问。
2. 可用 HTTPS Vault、Transit AES 密钥、只具备 decrypt 权限的短期 token 文件，以及已包装的主密钥文件。全新数据使用 `--new`，迁移必须用 `--wrap-existing` 包装**原主密钥**，否则历史 PAT 无法解密。
3. 云效 API endpoint、组织 ID、可信 Git HTTPS 主机名、服务域名和允许创建 write Key 的用户 ID。配置 DNS、防火墙和出网，使 CodeHarbor 可访问云效与 Vault；Webhook 的反向代理必须可由云效访问。
4. 持久化数据卷（以运行用户 UID 1000 可读写），Git 凭证助手所在的 `/tmp` 和数据卷必须允许执行文件。实际 Docker Compose 本地 secrets 可能保留宿主文件的 UID/权限，需确保应用 UID 可读，避免将密钥对无关用户开放。Vault token 文件更新及密钥轮换后需按运行策略重启并验证。
5. TLS 证书与私钥、独立的监控 token（至少 32 个可打印 ASCII 且无空格）、受信的固定 Nginx 镜像引用。实际生产镜像建议按组织策略固定摘要并扫描。

## 环境配置

在部署系统配置非敏感参数，密码、token 和已包装密钥通过受保护文件或企业秘密注入提供，**不要把文件内容写入仓库、镜像、shell 历史或日志**。

- `YUNXIAO_ENDPOINT`、`YUNXIAO_ORGANIZATION_ID`、`CODEHARBOR_GIT_HOSTS`：实际云效信息。
- `CODEHARBOR_ALLOWED_HOSTS`：代理对上游传递的主机名；若需要内部健康检查也加入 `127.0.0.1:8080`。浏览器调用时另设 `CODEHARBOR_ALLOWED_ORIGINS`（模板按需扩展）。
- `CODEHARBOR_WRITE_USERS`：经企业批准、可签发 write Key 的云效用户 ID；留空不允许 write Key。
- `CODEHARBOR_DATABASE_URL_FILE`：保存 PostgreSQL URL 的文件路径；也支持 `DATABASE_URL`，但不要同时配置。生产 URL 必须只使用单个 `sslmode=verify-full` 和可选 `application_name` 参数。
- `CODEHARBOR_VAULT_ADDR`、`CODEHARBOR_VAULT_TRANSIT_KEY`、`CODEHARBOR_VAULT_TOKEN_FILE`、`CODEHARBOR_VAULT_WRAPPED_KEY_FILE`：参见 [Vault Transit 指南](vault-transit.md)。
- `CODEHARBOR_METRICS_TOKEN_FILE`、`CODEHARBOR_TLS_CERT`、`CODEHARBOR_TLS_KEY`：分别指向监控 token、TLS 证书和私钥文件。
- `CODEHARBOR_NGINX_IMAGE`：经过批准的 Nginx 镜像完整引用；`CODEHARBOR_LISTEN_ADDR` 默认 `127.0.0.1`，只有配好企业访问策略后才应调整。

### 方式一：使用远端 PostgreSQL

将 `CODEHARBOR_DATABASE_URL_FILE` 指向保存远端 PostgreSQL URL 的宿主机文件，URL 主机名须与数据库证书一致。使用公认 CA 时可直接使用默认信任链；使用企业私有 CA 时通过受控的 Compose override 将 CA 文件挂载到应用容器，并设置 `NODE_EXTRA_CA_CERTS` 指向该容器内文件。不要关闭证书验证。

将变量中的路径设置为宿主机上的实际文件，确认应用用户能读取。可先使用以下命令检查模板，不必启动服务：

```sh
docker compose -f deploy/compose.yaml config --quiet
```

确认数据、证书、网络与备份配置之后，按企业部署流程构建并启动：

```sh
docker compose -f deploy/compose.yaml build
docker compose -f deploy/compose.yaml up -d
```

这些命令不会初始化 Vault 密钥、生成数据库凭证或自动配置云效 Webhook。代理后的 PAT 绑定限流目前按连接来源 IP 计数；如果所有连接从同一反向代理进入，它们可能共享限额。不要盲目信任 `X-Forwarded-For`，应在可信网关配置限流，或实现并测试可信代理策略。

### 方式二：使用 Docker 本地 PostgreSQL

保留前述 Vault、云效、Nginx 及应用必需的配置，再叠加 `deploy/compose.postgres.yaml`。该服务默认创建管理员 `codeharbor_admin`、非超级用户的应用账户 `codeharbor` 和对应数据库；应用账户可以在自身数据库中建表，不能创建数据库或角色。数据保存在 Docker 命名卷，仅允许 Compose 内网访问，默认不向宿主机开放数据库端口。数据库 URL 应使用应用账户、`postgres` 主机名和 `sslmode=verify-full`，数据库证书的 SAN 必须包含 `DNS:postgres`。

准备以下受保护的宿主文件，并导出其路径：

- `CODEHARBOR_POSTGRES_ADMIN_PASSWORD_FILE`：管理员初始化密码文件，只用于数据库初始化与维护；可通过 `CODEHARBOR_POSTGRES_ADMIN_USER` 覆盖默认管理员名称。
- `CODEHARBOR_POSTGRES_PASSWORD_FILE`：应用账户初始化密码文件。
- `CODEHARBOR_POSTGRES_TLS_CERT`、`CODEHARBOR_POSTGRES_TLS_KEY`：数据库服务端证书和对应私钥。
- `CODEHARBOR_POSTGRES_CA_CERT`：应用用于验证数据库证书的 CA 文件；如 Vault 也使用私有 CA，此文件可包含两条受信 CA 证书链。
- `CODEHARBOR_DATABASE_URL_FILE`：保存使用应用账户的数据库 URL 的文件。默认用户和库均为 `codeharbor`；如设定 `CODEHARBOR_POSTGRES_USER` 或 `CODEHARBOR_POSTGRES_DB`，URL 也须同步调整。

账户和数据库仅在**空数据卷首次初始化**时创建。更改用户名、库名或密码文件不会自动修改已有数据卷中的用户及密码；更新时需执行受控的数据库用户变更并同步连接文件。

例如，在**隔离的本地测试环境**中可用 OpenSSL 建立临时 CA 和测试证书，使用安全文件目录而不是将密钥写入仓库。此示例不会配置 Vault、云效或 Nginx：

```sh
umask 077
export CODEHARBOR_SECRET_DIR="$(mktemp -d "$HOME/codeharbor-local-secrets.XXXXXXXX")"
openssl rand -hex 32 > "$CODEHARBOR_SECRET_DIR/postgres-password"
openssl rand -hex 32 > "$CODEHARBOR_SECRET_DIR/postgres-admin-password"
openssl req -x509 -newkey rsa:3072 -nodes -days 365 -subj '/CN=CodeHarbor Local Test CA' \
  -keyout "$CODEHARBOR_SECRET_DIR/ca.key" -out "$CODEHARBOR_SECRET_DIR/ca.crt"
openssl req -new -newkey rsa:3072 -nodes -subj '/CN=postgres' \
  -keyout "$CODEHARBOR_SECRET_DIR/postgres.key" -out "$CODEHARBOR_SECRET_DIR/postgres.csr"
printf 'subjectAltName=DNS:postgres\nextendedKeyUsage=serverAuth\n' > "$CODEHARBOR_SECRET_DIR/postgres.ext"
openssl x509 -req -days 365 -in "$CODEHARBOR_SECRET_DIR/postgres.csr" \
  -CA "$CODEHARBOR_SECRET_DIR/ca.crt" -CAkey "$CODEHARBOR_SECRET_DIR/ca.key" -CAcreateserial \
  -extfile "$CODEHARBOR_SECRET_DIR/postgres.ext" -out "$CODEHARBOR_SECRET_DIR/postgres.crt"
python3 - <<'PY'
import os
from pathlib import Path
from urllib.parse import quote
directory = Path(os.environ['CODEHARBOR_SECRET_DIR'])
password = (directory / 'postgres-password').read_text().strip()
(directory / 'database-url').write_text(
    f'postgresql://codeharbor:{quote(password, safe="")}@postgres:5432/codeharbor?sslmode=verify-full\n'
)
PY
export CODEHARBOR_POSTGRES_PASSWORD_FILE="$CODEHARBOR_SECRET_DIR/postgres-password"
export CODEHARBOR_POSTGRES_ADMIN_PASSWORD_FILE="$CODEHARBOR_SECRET_DIR/postgres-admin-password"
export CODEHARBOR_POSTGRES_TLS_CERT="$CODEHARBOR_SECRET_DIR/postgres.crt"
export CODEHARBOR_POSTGRES_TLS_KEY="$CODEHARBOR_SECRET_DIR/postgres.key"
export CODEHARBOR_POSTGRES_CA_CERT="$CODEHARBOR_SECRET_DIR/ca.crt"
export CODEHARBOR_DATABASE_URL_FILE="$CODEHARBOR_SECRET_DIR/database-url"
```

生产环境应使用企业批准的 CA 和私钥管理流程，不应使用示例自签 CA。示例生成的目录每次均为新目录；若 Docker Compose 本地文件挂载保留宿主机权限，需按部署平台安全策略赋予应用 UID 1000 读取 `database-url` 和 CA 文件的权限，以及确保数据库容器能读取其密码、证书与私钥。请同时保证密钥不对无关用户开放。也可仅启动本地数据库（需事先准备上述五个 PostgreSQL 文件变量）：

```sh
docker compose -f deploy/compose.postgres.yaml up -d postgres
```

准备好所有基础环境配置后，启动完整服务：

```sh
docker compose -f deploy/compose.yaml -f deploy/compose.postgres.yaml config --quiet
docker compose -f deploy/compose.yaml -f deploy/compose.postgres.yaml up -d --build
```

保留并备份数据库卷、证书及密钥；不要使用会删除卷的命令代替常规停机。Docker Compose 的 `restart` 不能仅凭健康检查失败自动重启容器，数据库不可用时应结合外部监控和服务恢复策略。切换远端与本地数据库只改变连接目标，不会自动复制数据；已有数据须通过一致性备份/恢复或迁移完成转移，并验证身份、仓库及索引状态。

## 从 MVP SQLite 迁移

1. 停止旧服务及 Worker，备份 SQLite 数据库（包含 WAL 一致性状态）、数据目录和原主密钥，并演练恢复。目标 PostgreSQL 数据库必须为空。
2. 在相同或经过验证的挂载路径恢复索引目录。离线迁移复制已有绝对路径，换路径时必须先完成受控路径迁移，不能仅复制数据库。
3. 通过 Vault Transit 用 `--wrap-existing` 包装旧主密钥，并验证可以解密备份数据。不要用新随机密钥覆盖旧密钥。
4. 在可信环境通过 `DATABASE_URL` 或 `CODEHARBOR_DATABASE_URL_FILE` 提供目标地址，执行：

   ```sh
   node dist/migrate-sqlite.js --source /path/to/codeharbor.sqlite --confirm-source-offline
   ```

   迁移事务检查目标库为空并导入；运行中的任务转为待处理。失败时不会将部分记录提交到目标库。生产模式同样要求数据库连接通过 TLS 验证。
5. 启动单实例并核对用户 Key、仓库、索引 commit 和任务状态；用测试用户验证权限、Webhook 和同步。失败时停机回滚到保留的旧数据库、旧主密钥与原数据目录。不可在两个实例同时访问共享仓库目录。

## 监控与恢复

`/health/live` 表示进程响应；`/health/ready` 会检查持锁数据库连接及 CodeGraph MCP 工具。`/metrics` 使用独立 Bearer token，只输出聚合 HTTP 请求数与耗时；当前没有队列长度、索引延迟或云效错误等完整生产指标，需后续补齐。Fastify 输出结构化请求和审计日志；MCP 工具调用记录受控工具名、成功或失败及已授权的仓库 ID，不记录查询内容或源码。日志采集、访问控制、保留和告警由部署平台负责。

定期测试 PostgreSQL 备份、Vault Transit 旧密钥版本与包装文件、索引磁盘备份或重建，以及 Git/云效凭证重新授权。恢复后检查数据库路径、CodeGraph 版本、仓库 commit 和密钥一致性，再恢复流量。安装与配置所需的具体凭证、云资源和内网权限需要公司提供。
