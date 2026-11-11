# 索引队列监控

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
