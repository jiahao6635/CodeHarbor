# 镜像模式部署准备

此模板用于单服务器评估镜像模式。CodeHarbor 应用在 `/data` 的 tmpfs 中临时克隆和建立索引，查询容器使用只读镜像；不会把 Git 工作树或索引目录挂载为持久卷。Docker 镜像、层和构建缓存仍保存在 Docker 主机存储中，包含源码，须按源码等级保护。PostgreSQL 和 Vault 的持久化方案保持不变。

控制器是独立进程，只有它持有 Docker socket；公网网关不挂载该 socket。**Docker socket 本身仍提供高度敏感的宿主机控制能力**，Unix socket 协议限制不等同于 Docker daemon 权限隔离；仅在可信主机、专用控制器和独立系统账号边界下使用。按企业策略限制 Docker 访问、镜像/缓存与日志，并保持控制器单实例。

## 准备目录和令牌

需要 Compose 2.24.4 或更新版本（支持 `!override`），以及 Linux Docker daemon。由运维预先创建下列**专用且不存在的目录**，不要对已有的他人目录执行 `chown` 或 `chmod`：

| 环境变量 | 容器用途 | 宿主机目录权限 |
|---|---|---|
| `CODEHARBOR_IMAGE_CONTROLLER_SOCKET_DIR` | 控制器 build/query Unix socket | UID 0、GID 1000，`0750` |
| `CODEHARBOR_IMAGE_AUTHORIZER_SOCKET_DIR` | 应用仓库授权 Unix socket | UID 1000、GID 1000，`0750` |
| `CODEHARBOR_IMAGE_STATE_DIR` | 控制器的 allowlist、构建状态和创建 fence | UID 0、GID 0，`0700`；必须是持久存储 |

UID 1000 所属组应仅包含网关和控制器。目录的父路径和实际挂载权限也必须可信，不能允许其他用户替换或写入目录。控制器以 UID 0、GID 1000 运行且丢弃全部 Linux capabilities；应用授权 socket 需为 `0660`，才能由控制器所属组访问。

准备三个不同的随机令牌，每个至少 32 字节：`CODEHARBOR_IMAGE_QUERY_TOKEN_HOST_FILE`、`CODEHARBOR_IMAGE_BUILD_TOKEN_HOST_FILE`、`CODEHARBOR_IMAGE_AUTH_TOKEN_HOST_FILE`。使用受保护文件并让应用 UID 1000 与控制器能读取；例如在受控目录内按 root:1000、`0640` 保存。不要将令牌值写入 Compose、命令参数、仓库或日志。Compose 的本地 file secret 会沿用宿主机文件权限，须在实际部署环境验证读取权限。

`CODEHARBOR_IMAGE_CONTROLLER_ID` 使用稳定且在同一 Docker daemon 上唯一的标识，只允许一个控制器使用该 ID 和 socket 路径。运行态查询容器以该标识标记；控制器启动后仅清理能核实属于自身的残留容器。不要运行同一 ID 的多个副本。

## 配置与启动

先按 `codegraph-readonly/README.md` 构建经过固定版本补丁的 CodeGraph 只读基础镜像，并在同一 Docker daemon 中设置其不可变本地镜像 ID：

```sh
export CODEHARBOR_REPOSITORY_RUNTIME_IMAGE="$(docker image inspect codeharbor-codegraph-readonly:1.6.2 --format '{{.Id}}')"
```

配置以上目录、令牌文件和控制器 ID，同时准备 `production-deployment.md` 中已有的云效、PostgreSQL、Vault、TLS 和 Nginx 配置。若需本机 PostgreSQL，在基础文件和镜像文件之间加入 `deploy/compose.postgres.yaml`。

`CODEHARBOR_DOCKER_CLI_IMAGE` 控制构建控制器镜像所用的 Docker CLI 镜像，默认 `docker:27-cli`；生产构建应指定企业审核并固定 digest 的镜像。控制器最终仍连接宿主机 Docker daemon，应确认客户端与 daemon 版本兼容。

`compose.image.yaml` 使用 `!override` 替换应用的全部 `volumes`，以确保旧仓库卷不再挂载；这也会移除前面其他 Compose 文件加上的 CA 证书或其他业务挂载。部署前必须用最终 Compose 配置逐项核对原有非仓库挂载，在镜像配置之后通过受控的附加 override 显式恢复仍需的证书等挂载；不要把旧 Git 工作树卷重新挂入。Compose `secrets` 与 PostgreSQL 配置不会因这个 `volumes` 覆盖而自动移除，但仍需逐项核查源文件和访问权限。

```sh
docker compose -f deploy/compose.yaml -f deploy/compose.image.yaml config --quiet
docker compose -f deploy/compose.yaml -f deploy/compose.image.yaml build
docker compose -f deploy/compose.yaml -f deploy/compose.image.yaml up -d
```

镜像模式为应用的 `/data` 和控制器的 `/tmp` 使用 tmpfs，默认各为 2 GiB；通过 `CODEHARBOR_IMAGE_WORKTREE_TMPFS_SIZE`、`CODEHARBOR_IMAGE_BUILD_TMPFS_SIZE` 按真实仓库大小调整。网关 `TMPDIR=/data`，使克隆、索引和 Git 凭据助手的临时文件使用可执行的 `/data` tmpfs。tmpfs 会消耗内存或交换空间，资源不足时构建会失败；不要将临时构建空间误当成无限容量。控制器构建镜像时使用本机 Docker daemon，固定基础镜像必须已存在。

应用 `/health/ready` 在镜像模式只验证受限调度器可用，并不证明每个仓库的镜像或云效权限正常。候选镜像发布前会执行实际 MCP 查询；上线还须验证真实授权、代码查询、超时、回滚、镜像空间及服务器重启恢复。

## 恢复和切换

数据库中的旧目录记录会触发镜像重建；首次运行前先完整备份现有数据库、Vault 凭据及旧仓库卷。镜像模式不会使用旧 Git 卷，但迁移验证和回滚之前必须保留它；不要使用 `down -v` 或 Docker 清理命令删除这些数据。旧索引的历史请求在镜像完成构建前可能不可用，需选择维护窗口并验证迁移结果。

控制器重启或主机异常退出后，Unix socket 文件可能残留。仅在确认旧控制器和网关都已停止、目标确为上述专用目录中的 socket 文件后，按运维流程清除残留 socket。不要盲目删除其他文件。

如果 socket 专用目录位于 `/run`，操作系统重启后该目录可能消失；应由受控的系统服务或 tmpfiles 配置在服务启动前重新建立专用目录及权限，不应由应用自动修改已有目录。

若创建 fence 或构建状态标记要求运维恢复，不要仅凭 `docker ps` 为空就移除标记：Docker daemon 可能仍在处理迟到的创建或构建。应先隔离服务，核实并处理 daemon 中所有未完成请求和所属资源，再由授权运维确认状态并按恢复流程处理标记。allowlist 和 fence 目录不可放在临时目录或容器可写层。
