# 仓库镜像与只读查询

镜像模式将每个仓库的源码快照和索引封装进本机 Docker 镜像。外部 MCP 地址与原有鉴权保持不变；CodeHarbor 只将已授权的仓库 ID、commit 和本机镜像 ID 发送给独立控制器。查询容器使用只读根文件系统、非 root 用户、无网络、无仓库挂载，使用打过只读补丁的 CodeGraph 1.6.2。镜像层仍占用 Docker 宿主机的磁盘；平台数据库和密钥管理也仍需持久化。

目前的 `oci://sha256:...` 表示**本机 Docker image ID**，并非远程镜像仓库的 manifest digest；该模式只支持单机 Docker，不支持将其当作跨主机镜像引用或高可用方案。镜像、Docker 构建缓存和临时源码都应按源码等级限制访问。终端用户不能获得镜像拉取或 Docker 控制权限，否则可以绕开 CodeHarbor 鉴权。

当前单个仓库的源码和索引快照合计最多 512 MiB，源码树最多 50,000 个条目、64 层目录；符号链接和特殊文件会被拒绝。超过这些边界的仓库构建会失败，需要先调整并验证资源限制。

## 组件和配置

- 编译 `codegraph-readonly/Dockerfile`，固定该镜像的本机 `sha256:...` image ID，配到 `CODEHARBOR_REPOSITORY_RUNTIME_IMAGE`。该镜像不包含仓库，源码和一致的 SQLite 索引由受控构建器加入。构建说明和只读测试见 [只读运行时](../codegraph-readonly/README.md)。
- CodeHarbor 设置 `CODEHARBOR_INDEX_BACKEND=image`，并配置 `CODEHARBOR_IMAGE_QUERY_SOCKET`、`CODEHARBOR_IMAGE_BUILD_SOCKET`、`CODEHARBOR_IMAGE_AUTH_SOCKET`，以及各自的 `CODEHARBOR_IMAGE_QUERY_TOKEN_FILE`、`CODEHARBOR_IMAGE_BUILD_TOKEN_FILE`、`CODEHARBOR_IMAGE_AUTH_TOKEN_FILE`。三个 token 必须分别保存在受保护文件中，且至少 32 字节；不要放入源码、镜像或命令参数。
- 镜像模式在开发和生产环境都强制使用 PostgreSQL，避免应用数据静默落入临时 SQLite。生产环境仍要求验证数据库 TLS 和 Vault Transit。
- 单独运行 `node dist/image-controller.js`；它负责固定的镜像构建和只读查询，是唯一需要 Docker daemon 访问的进程。配置相同的 runtime image、socket 和 token 文件，以及控制器独有的 `CODEHARBOR_IMAGE_ALLOWLIST`、`CODEHARBOR_IMAGE_FENCE_DIR`、`CODEHARBOR_IMAGE_BUILD_WORK_DIR` 和稳定唯一的 `CODEHARBOR_IMAGE_CONTROLLER_ID`。控制器工作目录必须放在受限、容量足够的临时文件系统；可信清单和 fence 目录必须持久化并只允许控制器写入。
- 查询、构建和控制面授权是三个不同的 Unix socket。它们的父目录必须分别由对应服务的 UID 拥有且不允许组或其他用户写入。控制器的 socket 可设为组可访问，但目录的组只应包含 CodeHarbor 服务用户。Docker socket 不得交给网关、仓库容器或其他用户。
- 每个候选镜像先经仓库 ID、commit、可信构建记录及当前发布/候选状态验证，再启动容器做真实 MCP 查询；切换前再次检查远端分支。构建失败、授权失效或分支更新时不会发布候选版本。

镜像模式的 `/health/ready` 仅检查数据库及 Docker 调度控制器是否可用；它不逐个验证已发布仓库镜像。候选镜像在发布前会执行真实 CodeGraph 查询，运维还应监控构建失败、任务堆积及仓库状态。

## 从工作树迁移

切换前备份 PostgreSQL、Vault 配置及现有工作树卷，保留旧镜像和原启动配置。启用镜像模式时，原本指向工作树的仓库会自动排队重新从云效构建镜像；这些仓库在新镜像发布前无法通过镜像后端查询，失败的仓库需要排查并重试。原目录不会在镜像发布时自动删除。用户必须自行确认所有仓库的权限、commit 和 MCP 查询均正确后，才能按既有恢复策略决定是否移除旧卷。

若迁移失败，停止新应用和控制器，恢复旧启动配置及原卷，然后启动旧版本；如数据库已更新为 `oci://...` 引用，也必须根据切换前的一致性备份恢复对应元数据。不要在没有协调数据库和索引数据的情况下简单切换镜像版本，也不要两个应用同时访问同一数据库或仓库数据。

## 故障恢复

构建或创建容器的结果不确定时，控制器会保留持久 fence 并拒绝继续操作。重启不能解除 fence：先由运维确认 Docker daemon 不再执行迟到的构建/创建、检查并处理属于该控制器的临时源码目录、容器和镜像，再按运维流程恢复对应受保护状态。不要自动删除未知容器、镜像或卷。正常退出会清理工作目录，但进程崩溃时需检查；构建工作区应使用受限 tmpfs 并设置容量和监控。

发布镜像时，数据库记录当前镜像以及上一镜像的 ID 和 commit；旧镜像和构建缓存目前不会自动清理。当前没有针对上一镜像的受控验证与回滚接口，不能仅凭记录或直接改数据库完成安全回滚；如需恢复，应使用事先演练的一致性备份恢复流程，并考虑恢复其他数据库变更的影响。不要使用全局 `docker system prune`。
