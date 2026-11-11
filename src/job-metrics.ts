import { BUILD_DURATION_BUCKETS_MS, type JobMetrics } from './store.js';

/** A rolling database snapshot: these values are gauges, not cumulative counters. */
export function renderJobMetrics(metrics: JobMetrics, nowMs: number): string {
  const seconds = (value: number | null) => value === null ? 'NaN' : String(value / 1000);
  const wait = metrics.oldestQueuedAt === null ? 0 : Math.max(0, nowMs - metrics.oldestQueuedAt) / 1000;
  const ratio = metrics.completed24h === 0 ? 'NaN' : String(metrics.failed24h / metrics.completed24h);
  const average = metrics.builds24h === 0 ? null : metrics.buildDurationSumMs24h / metrics.builds24h;
  const output = [
    '# HELP codeharbor_index_queue_queued_jobs Current queued index jobs; excludes running jobs.',
    '# TYPE codeharbor_index_queue_queued_jobs gauge',
    `codeharbor_index_queue_queued_jobs ${metrics.queued}`,
    '# HELP codeharbor_index_queue_oldest_wait_seconds Longest current queue wait; zero when the queue is empty.',
    '# TYPE codeharbor_index_queue_oldest_wait_seconds gauge',
    `codeharbor_index_queue_oldest_wait_seconds ${wait}`,
    '# HELP codeharbor_index_jobs_completed_24h Index jobs completed in the last 24 hours, including no-change reconciliations.',
    '# TYPE codeharbor_index_jobs_completed_24h gauge',
    `codeharbor_index_jobs_completed_24h{outcome="succeeded"} ${metrics.succeeded24h}`,
    `codeharbor_index_jobs_completed_24h{outcome="failed"} ${metrics.failed24h}`,
    '# HELP codeharbor_index_jobs_failure_ratio_24h Failed/completed jobs in the last 24 hours; NaN if there are no samples.',
    '# TYPE codeharbor_index_jobs_failure_ratio_24h gauge',
    `codeharbor_index_jobs_failure_ratio_24h ${ratio}`,
    '# HELP codeharbor_index_build_samples_24h Completed jobs with a measured build in the last 24 hours.',
    '# TYPE codeharbor_index_build_samples_24h gauge',
    `codeharbor_index_build_samples_24h ${metrics.builds24h}`,
    '# HELP codeharbor_index_build_duration_mean_24h_seconds Mean actual build duration in the last 24 hours; NaN if there are no samples.',
    '# TYPE codeharbor_index_build_duration_mean_24h_seconds gauge',
    `codeharbor_index_build_duration_mean_24h_seconds ${seconds(average)}`,
    '# HELP codeharbor_index_build_duration_max_24h_seconds Maximum actual build duration in the last 24 hours; NaN if there are no samples.',
    '# TYPE codeharbor_index_build_duration_max_24h_seconds gauge',
    `codeharbor_index_build_duration_max_24h_seconds ${seconds(metrics.buildDurationMaxMs24h)}`,
    '# HELP codeharbor_index_build_duration_last_24h_seconds Most recent actual build duration in the last 24 hours; NaN if there are no samples.',
    '# TYPE codeharbor_index_build_duration_last_24h_seconds gauge',
    `codeharbor_index_build_duration_last_24h_seconds ${seconds(metrics.buildDurationLastMs24h)}`,
    '# HELP codeharbor_index_build_duration_24h_bucket Cumulative counts by build duration upper bound in seconds for the last 24 hours.',
    '# TYPE codeharbor_index_build_duration_24h_bucket gauge',
  ];
  BUILD_DURATION_BUCKETS_MS.forEach((bound, index) => output.push(`codeharbor_index_build_duration_24h_bucket{le="${bound / 1000}"} ${metrics.buildBuckets24h[index]}`));
  output.push(`codeharbor_index_build_duration_24h_bucket{le="+Inf"} ${metrics.builds24h}`);
  return `${output.join('\n')}\n`;
}
