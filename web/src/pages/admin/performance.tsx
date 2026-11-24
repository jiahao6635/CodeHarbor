import {
  ArrowsClockwise,
  CheckCircle,
  Cpu,
  HardDrives,
  Memory,
  Pause,
  Play,
  Warning,
  XCircle,
} from '@phosphor-icons/react';
import { type ReactNode, useState } from 'react';
import { ApiError } from '@/api/client';
import { useAdminSystemPerformance } from '@/api/hooks';
import type { AdminSystemPerformance } from '@/api/types';
import { ErrorNotice } from '@/components/error-notice';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatAbsolute } from '@/lib/format';

const NO_READING = '暂无读数';
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const percentFormat = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
const fenceLabels: Record<string, string> = {
  graph_client: 'CodeGraph 客户端',
  image_query: '镜像查询',
  image_runtime: '镜像运行时',
};

function bytes(value: number | null) {
  if (value === null) return NO_READING;
  const exponent = [4, 3, 2, 1].find((index) => value >= 1024 ** index) ?? 0;
  return `${numberFormat.format(value / 1024 ** exponent)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][exponent]}`;
}

function cores(value: number | null) {
  return value === null ? NO_READING : `${numberFormat.format(value)} 核`;
}

function uptime(seconds: number) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时 ${minutes} 分钟`;
  if (hours) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes) return `${minutes} 分 ${Math.floor(seconds % 60)} 秒`;
  return `${Math.floor(seconds)} 秒`;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular">{children}</dd>
    </div>
  );
}

function DependencyStatus({ available }: { available: boolean }) {
  return available ? (
    <Badge tone="ready">
      <CheckCircle aria-hidden="true" />
      正常
    </Badge>
  ) : (
    <Badge tone="error">
      <XCircle aria-hidden="true" />
      不可用
    </Badge>
  );
}

function HealthCard({
  health,
  sampledAt,
  stale,
  autoRefresh,
}: {
  health: AdminSystemPerformance['health'];
  sampledAt: string;
  stale: boolean;
  autoRefresh: boolean;
}) {
  const healthy = health.status === 'ok';
  const fenced = Object.entries(health.fenced)
    .filter(([, active]) => active)
    .map(([component]) => fenceLabels[component] ?? component);
  return (
    <Card aria-labelledby="health-overview">
      <CardHeader className="flex-wrap items-center">
        <div>
          <CardTitle id="health-overview">服务健康</CardTitle>
          <p className="text-xs text-muted-foreground">
            采样于{' '}
            <time dateTime={sampledAt} className="tabular">
              {formatAbsolute(sampledAt)}
            </time>
            {' · '}
            {autoRefresh ? '每 15 秒刷新' : '自动刷新已暂停'}
          </p>
        </div>
        <span role="status" aria-atomic="true">
          <Badge tone={healthy ? 'ready' : 'warning'}>
            {healthy ? <CheckCircle aria-hidden="true" /> : <Warning aria-hidden="true" />}
            <span className="sr-only">服务健康：</span>
            {stale ? '上次状态 · ' : ''}
            {healthy ? '运行正常' : '服务降级'}
          </Badge>
        </span>
      </CardHeader>
      <dl className="grid gap-2 border-t border-border pt-3 sm:grid-cols-2 sm:gap-x-6">
        <Fact label="数据库">
          <DependencyStatus available={health.database === 'ok'} />
        </Fact>
        <Fact label="索引运行时">
          <DependencyStatus available={health.indexRuntime === 'ok'} />
        </Fact>
        {fenced.length > 0 ? <Fact label="已触发运行保护">{fenced.join('、')}</Fact> : null}
      </dl>
    </Card>
  );
}

function ResourceCard({
  title,
  description,
  icon: Icon,
  usage,
  children,
}: {
  title: string;
  description: string;
  icon: typeof Cpu;
  usage: number | null;
  children: ReactNode;
}) {
  const gaugeValue = usage === null ? null : Math.min(1, Math.max(0, usage));
  return (
    <Card className="min-w-0">
      <CardHeader>
        <div>
          <h3 className="text-base font-semibold">{title}</h3>
          <CardDescription className="text-xs">{description}</CardDescription>
        </div>
        <Icon className="mt-1 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </CardHeader>
      <p className="mb-2 text-xl font-semibold tabular">{usage === null ? NO_READING : percentFormat.format(usage)}</p>
      {gaugeValue !== null ? (
        <>
          <meter className="sr-only" aria-label={`${title}使用率`} min={0} max={1} value={gaugeValue} />
          <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div className="h-full rounded-full bg-accent" style={{ width: `${gaugeValue * 100}%` }} />
          </div>
        </>
      ) : null}
      <dl className="space-y-1.5">{children}</dl>
    </Card>
  );
}

function Resources({ performance }: { performance: AdminSystemPerformance['performance'] }) {
  const { system, storage, process, cgroup } = performance;
  const memoryUsed = Math.max(0, system.totalMemoryBytes - system.availableMemoryBytes);
  const storageOccupied = storage ? Math.max(0, storage.totalBytes - storage.availableBytes) : 0;
  const load = system.loadAverage;
  return (
    <>
      <section aria-labelledby="system-resources">
        <h2 id="system-resources" className="mb-3 text-base font-semibold">
          系统资源
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ResourceCard title="CPU" description="操作系统可见范围" icon={Cpu} usage={system.cpuUsageRatio}>
            <Fact label="逻辑核心">{numberFormat.format(system.cpuCount)}</Fact>
            <Fact label="负载（1 / 5 / 15 分钟）">
              {load
                ? [load.oneMinute, load.fiveMinutes, load.fifteenMinutes]
                    .map((value) => numberFormat.format(value))
                    .join(' / ')
                : NO_READING}
            </Fact>
            <Fact label="系统运行时长">{uptime(system.uptimeSeconds)}</Fact>
          </ResourceCard>
          <ResourceCard
            title="内存"
            description="操作系统可见范围"
            icon={Memory}
            usage={system.totalMemoryBytes > 0 ? memoryUsed / system.totalMemoryBytes : null}
          >
            <Fact label="已用 / 总量">
              {bytes(memoryUsed)} / {bytes(system.totalMemoryBytes)}
            </Fact>
            <Fact label="可用">{bytes(system.availableMemoryBytes)}</Fact>
          </ResourceCard>
          <ResourceCard
            title="数据盘"
            description="CodeHarbor 数据目录所在文件系统"
            icon={HardDrives}
            usage={storage && storage.totalBytes > 0 ? storageOccupied / storage.totalBytes : null}
          >
            {storage ? (
              <>
                <Fact label="已占用及保留 / 总量">
                  {bytes(storageOccupied)} / {bytes(storage.totalBytes)}
                </Fact>
                <Fact label="可用">{bytes(storage.availableBytes)}</Fact>
              </>
            ) : null}
          </ResourceCard>
        </div>
      </section>
      <section aria-labelledby="instance-resources">
        <h2 id="instance-resources" className="mb-3 text-base font-semibold">
          当前实例
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <h3 className="text-base font-semibold">CodeHarbor 进程</h3>
            </CardHeader>
            <dl className="space-y-1.5">
              <Fact label="进程运行时长">{uptime(process.uptimeSeconds)}</Fact>
              <Fact label="CPU 使用量">{cores(process.cpuUsageCores)}</Fact>
              <Fact label="常驻内存（RSS）">{bytes(process.residentMemoryBytes)}</Fact>
            </dl>
          </Card>
          {cgroup ? (
            <Card>
              <CardHeader>
                <div>
                  <h3 className="text-base font-semibold">Linux 资源组</h3>
                  <CardDescription className="text-xs">当前服务所在 cgroup</CardDescription>
                </div>
              </CardHeader>
              <dl className="space-y-1.5">
                <Fact label="CPU 使用量">{cores(cgroup.cpuUsageCores)}</Fact>
                <Fact label="CPU 限额">
                  {cgroup.cpuLimitCores === null ? '无可用限额读数' : cores(cgroup.cpuLimitCores)}
                </Fact>
                <Fact label="内存使用量">{bytes(cgroup.memoryUsageBytes)}</Fact>
                <Fact label="内存限额">
                  {cgroup.memoryLimitBytes === null ? '无可用限额读数' : bytes(cgroup.memoryLimitBytes)}
                </Fact>
              </dl>
            </Card>
          ) : null}
        </div>
      </section>
    </>
  );
}

export default function AdminPerformancePage() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const query = useAdminSystemPerformance(autoRefresh);
  const forbidden = query.error instanceof ApiError && query.error.status === 403;
  const snapshot = forbidden ? undefined : query.data;
  return (
    <>
      <PageHeader
        title="服务运行状态"
        actions={
          <>
            <Button variant="ghost" className="min-h-11 sm:min-h-0" onClick={() => setAutoRefresh(!autoRefresh)}>
              {autoRefresh ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              {autoRefresh ? '暂停刷新' : '继续刷新'}
            </Button>
            <Button
              variant="secondary"
              className="min-h-11 sm:min-h-0"
              onClick={() => void query.refetch()}
              loading={query.isFetching}
            >
              {!query.isFetching ? <ArrowsClockwise aria-hidden="true" /> : null}
              立即刷新
            </Button>
          </>
        }
      />
      <div className="space-y-5">
        {query.isError ? (
          <ErrorNotice error={query.error} title={snapshot ? '刷新失败，显示上次采样' : '无法读取运行状态'} />
        ) : null}
        {query.isPending ? (
          <div className="space-y-4" role="status" aria-busy="true" aria-label="正在读取运行状态">
            <Skeleton className="h-28 w-full" />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {['cpu', 'memory', 'disk'].map((id) => (
                <Skeleton key={id} className="h-44 w-full" />
              ))}
            </div>
          </div>
        ) : null}
        {snapshot ? (
          <>
            <HealthCard
              health={snapshot.health}
              sampledAt={snapshot.performance.sampledAt}
              stale={query.isError}
              autoRefresh={autoRefresh}
            />
            <Resources performance={snapshot.performance} />
          </>
        ) : null}
      </div>
    </>
  );
}
