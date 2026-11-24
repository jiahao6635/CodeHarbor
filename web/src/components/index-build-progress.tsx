import { useJob, useRepositoryJobs } from '@/api/hooks';
import type { Job, JobPhase } from '@/api/types';
import { cn } from '@/lib/cn';

const PHASES: Record<JobPhase, { value: number; label: string }> = {
  queued: { value: 0, label: '等待执行' },
  validating: { value: 1, label: '校验权限和版本' },
  cloning: { value: 2, label: '拉取代码' },
  indexing: { value: 3, label: '构建索引' },
  packaging: { value: 4, label: '打包镜像' },
  publishing: { value: 5, label: '验证和发布索引' },
  complete: { value: 6, label: '任务完成' },
};

function ProgressBar({ job, showError }: { job?: Job; showError?: boolean }) {
  const phase = job?.phase ?? (job?.status === 'queued' ? 'queued' : undefined);
  const stage = phase ? PHASES[phase] : undefined;
  const failed = job?.status === 'failed';
  const complete = job?.status === 'succeeded';
  const label = job ? '正在构建' : '正在读取索引任务';
  const summary = failed ? '构建失败' : complete ? PHASES.complete.label : (stage?.label ?? label);
  const value = complete ? PHASES.complete.value : (stage?.value ?? (failed ? 0 : undefined));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-muted-foreground">索引构建进度</span>
        <output className={failed ? 'text-status-error' : undefined}>
          {summary}
          {failed && stage ? `（${stage.label}）` : null}
        </output>
      </div>
      <progress
        aria-label="索引构建进度"
        aria-valuetext={summary}
        className={cn('block h-2 w-full', failed ? 'accent-status-error' : 'accent-status-progress')}
        max={PHASES.complete.value}
        value={value}
      />
      {showError && failed && job?.error ? <p className="text-xs text-status-error">{job.error}</p> : null}
    </div>
  );
}

function RepositoryProgress({ repoId, repositoryActive }: { repoId: string; repositoryActive?: boolean }) {
  const { data } = useRepositoryJobs(repoId, { watchIdle: true, repositoryActive });
  const job =
    data?.find((entry) => entry.status === 'running') ?? data?.find((entry) => entry.status === 'queued') ?? data?.[0];
  if (!job && !repositoryActive) return null;
  return <ProgressBar job={job} />;
}

function JobProgress({ jobId }: { jobId: string }) {
  const { data, isError } = useJob(jobId);
  if (isError && !data) return <p className="text-sm text-status-error">暂时无法读取索引任务。</p>;
  return <ProgressBar job={data} showError />;
}

export function IndexBuildProgress(props: { repoId: string; repositoryActive?: boolean } | { jobId: string }) {
  return 'jobId' in props ? <JobProgress jobId={props.jobId} /> : <RepositoryProgress {...props} />;
}
