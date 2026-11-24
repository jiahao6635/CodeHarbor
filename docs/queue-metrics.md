# 运行监控

超级管理员通过飞书登录控制台，从「管理 → 运行状态」打开 `/ui/admin/performance`。页面显示数据库与索引运行时探测状态、运行时保护状态、资源指标及采样时间，前台每 15 秒刷新，也可暂停或手动刷新。超级管理员会话可调用 `GET /api/v1/admin/system/performance`。依赖探测失败、超过 3 秒或运行时保护触发时，接口返回 `health.status: degraded` 和当前资源采样。数据库故障如果影响会话鉴权，页面会提示刷新失败，并标记已有数据为上次采样。

## Prometheus 采集

应用的 `/metrics` 在配置 `CODEHARBOR_METRICS_TOKEN_FILE` 后使用独立的 Bearer token 提供 Prometheus 文本格式。部署模板不向公网开放该路径；应由受控内网采集。指标仅含固定标签，不含用户或仓库标识。

当前 Compose 模板没有发布应用的 8080 端口，Nginx 也会对 `/metrics` 返回 404，因此现有外部 Prometheus 不会自动采集到指标。一个可行方式是让 Prometheus 加入同一 Docker `backend` 网络，将监控 token 以只读文件挂载到 Prometheus，并在保留现有允许值的同时把 `codeharbor:8080` 加入 `CODEHARBOR_ALLOWED_HOSTS`，然后重启 CodeHarbor 使配置生效。Prometheus 的抓取配置示例：

```yaml
scrape_configs:
  - job_name: codeharbor
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /run/secrets/codeharbor_metrics_token
    static_configs:
      - targets: ['codeharbor:8080']
```

示例中的密钥路径是 Prometheus 容器内的路径，须由部署方配置只读挂载；上述明文连接仅适用于同一受信 Docker 网络。跨主机采集需要由运维另行配置受限的内网 TLS 入口及网络访问策略，勿直接将应用明文端口开放到公网。配置后应检查 Prometheus 的目标状态；`401` 通常表示 token 不正确，`403` 应检查 Host 白名单。

## 资源指标

| 指标 | 含义 |
| --- | --- |
| `codeharbor_system_cpu_logical_cores`、`codeharbor_system_cpu_usage_ratio` | 操作系统可见的逻辑 CPU 数和当前 CPU 使用率，使用率范围为 0–1。 |
| `codeharbor_system_load_average` | 操作系统可见的 1、5、15 分钟负载均值，分别用 `window="1m"`、`"5m"`、`"15m"` 标记。 |
| `codeharbor_system_memory_total_bytes`、`codeharbor_system_memory_available_bytes` | 操作系统可见的内存总量和可用量，单位为字节。可用量优先采用 Linux 的 `MemAvailable`，否则采用操作系统报告的空闲内存。 |
| `codeharbor_system_uptime_seconds`、`codeharbor_process_uptime_seconds` | 操作系统和 CodeHarbor 平台进程各自持续运行的秒数。 |
| `codeharbor_process_resident_memory_bytes`、`codeharbor_process_cpu_usage_cores` | CodeHarbor 平台进程的常驻内存字节数和当前 CPU 使用量。CPU 使用量为 `1` 表示占用一个逻辑核心。 |
| `codeharbor_cgroup_cpu_usage_cores`、`codeharbor_cgroup_cpu_limit_cores` | 进程所属 Linux cgroup v2 的当前 CPU 使用量和直接配置的配额，单位为逻辑核心。 |
| `codeharbor_cgroup_memory_usage_bytes`、`codeharbor_cgroup_memory_limit_bytes` | 进程所属 Linux cgroup v2 的当前内存使用量和直接配置的上限，单位为字节。 |
| `codeharbor_process_cpu_seconds_total`、`codeharbor_cgroup_cpu_seconds_total` | 平台进程与 Linux cgroup v2 各自累计的 CPU 时间，单位为秒，可用 `rate()` 计算一段时间内的平均 CPU 使用量。 |
| `codeharbor_data_filesystem_total_bytes`、`codeharbor_data_filesystem_available_bytes` | `CODEHARBOR_DATA_DIR` 所在文件系统的总容量和进程可用容量，单位为字节。 |

容器中的系统数据来自应用可见的操作系统，可能是宿主机或 Docker 虚拟机的全局视图。cgroup 配额和上限的口径为进程所属 cgroup 直接配置的值。数据目录所在文件系统可能由多个应用共享，镜像部署模板中的 `/data` 使用 tmpfs。应用无法读取的指标或无限制的配额会在采集结果中省略，控制台显示为不可用。

```promql
100 * codeharbor_system_cpu_usage_ratio
100 * (1 - codeharbor_data_filesystem_available_bytes / codeharbor_data_filesystem_total_bytes)
rate(codeharbor_process_cpu_seconds_total[5m])
```

## 索引队列指标

| 指标 | 含义 |
| --- | --- |
| `codeharbor_index_queue_queued_jobs` | 当前处于排队状态的索引任务数，不含运行中任务。 |
| `codeharbor_index_queue_oldest_wait_seconds` | 当前排队任务中最长的等待时间，空队列为 0 秒。任务重排后从重新入队时间计算；旧数据没有入队时间时使用创建时间。 |
| `codeharbor_index_jobs_completed_24h{outcome="succeeded"}` / `{outcome="failed"}` | 最近 24 小时完成的索引任务数，按最终状态区分。 |
| `codeharbor_index_jobs_failure_ratio_24h` | 最近 24 小时失败任务数除以全部完成任务数，范围 0–1；没有已完成任务时为 `NaN`。 |
| `codeharbor_index_build_samples_24h` | 最近 24 小时完成的任务中，记录了实际构建耗时的样本数。 |
| `codeharbor_index_build_duration_mean_24h_seconds`、`codeharbor_index_build_duration_max_24h_seconds`、`codeharbor_index_build_duration_last_24h_seconds` | 最近 24 小时实际构建耗时的平均值、最大值和最近一次值，单位秒；无样本时为 `NaN`。 |
| `codeharbor_index_build_duration_24h_bucket{le="..."}` | 最近 24 小时实际构建耗时按秒数上界累计的样本数量，`+Inf` 为全部样本数。 |

构建耗时从构建函数开始到结束，包含该函数内的克隆、CodeGraph 索引和镜像构建，但不包含构建前的权限和分支检查及构建后的发布流程。构建失败也计入耗时样本；没有代码变化而跳过构建的检查不计入。失败率统计的是**整个索引任务**的最终结果，包含鉴权、拉取、构建、发布等阶段的失败，以及无变化检查的成功；它不是仅针对构建阶段的失败率。

这些指标是数据库中最近 24 小时的滚动快照，均为 gauge，不是单调递增的计数器或 Prometheus 原生 histogram。任务到期移出窗口或被删除时，数量会下降；不要对其使用 `rate()` 或 `increase()`。升级之前的历史任务缺少完成时间和构建耗时，不计入历史统计；升级后完成的任务正常计入。服务重启后已持久化的完成记录仍可统计。

可在 Prometheus 中使用以下查询：

```promql
codeharbor_index_queue_queued_jobs
codeharbor_index_queue_oldest_wait_seconds
100 * codeharbor_index_jobs_failure_ratio_24h
codeharbor_index_build_samples_24h
codeharbor_index_build_duration_mean_24h_seconds
codeharbor_index_build_duration_last_24h_seconds
histogram_quantile(0.95, sum by (le) (codeharbor_index_build_duration_24h_bucket))
```

分位数是根据固定桶边界估算的值，样本少时可能不稳定；分析平均值、分位数和失败率时应同时查看样本数。告警阈值应根据任务量和构建耗时设定。
