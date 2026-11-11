import assert from 'node:assert/strict';
import test from 'node:test';
import { renderJobMetrics } from '../src/job-metrics.js';
import { BUILD_DURATION_BUCKETS_MS, type JobMetrics } from '../src/store.js';

const empty: JobMetrics = {
  queued: 0, oldestQueuedAt: null, completed24h: 0, succeeded24h: 0, failed24h: 0,
  builds24h: 0, buildDurationSumMs24h: 0, buildDurationMaxMs24h: null,
  buildDurationLastMs24h: null, buildBuckets24h: BUILD_DURATION_BUCKETS_MS.map(() => 0),
};

test('queue metrics distinguish an empty window from a zero failure rate', () => {
  const result = renderJobMetrics(empty, 100_000);
  assert.match(result, /^codeharbor_index_queue_queued_jobs 0$/m);
  assert.match(result, /^codeharbor_index_queue_oldest_wait_seconds 0$/m);
  assert.match(result, /^codeharbor_index_jobs_failure_ratio_24h NaN$/m);
  assert.match(result, /^codeharbor_index_build_duration_mean_24h_seconds NaN$/m);
  assert.match(result, /^codeharbor_index_build_duration_24h_bucket\{le="\+Inf"\} 0$/m);
});

test('queue metrics render seconds, failure ratio and cumulative rolling buckets', () => {
  const result = renderJobMetrics({
    queued: 3, oldestQueuedAt: 90_000, completed24h: 4, succeeded24h: 3, failed24h: 1,
    builds24h: 2, buildDurationSumMs24h: 6500, buildDurationMaxMs24h: 5500,
    buildDurationLastMs24h: 1000, buildBuckets24h: [1, 1, 2, 2, 2, 2, 2, 2, 2],
  }, 100_000);
  assert.match(result, /^codeharbor_index_queue_queued_jobs 3$/m);
  assert.match(result, /^codeharbor_index_queue_oldest_wait_seconds 10$/m);
  assert.match(result, /^codeharbor_index_jobs_completed_24h\{outcome="failed"\} 1$/m);
  assert.match(result, /^codeharbor_index_jobs_failure_ratio_24h 0\.25$/m);
  assert.match(result, /^codeharbor_index_build_duration_mean_24h_seconds 3\.25$/m);
  assert.match(result, /^codeharbor_index_build_duration_max_24h_seconds 5\.5$/m);
  assert.match(result, /^codeharbor_index_build_duration_last_24h_seconds 1$/m);
  assert.match(result, /^codeharbor_index_build_duration_24h_bucket\{le="10"\} 2$/m);
  assert.match(result, /^codeharbor_index_build_duration_24h_bucket\{le="\+Inf"\} 2$/m);
  assert.match(result, /^# TYPE codeharbor_index_build_duration_24h_bucket gauge$/m);
  assert.match(renderJobMetrics({ ...empty, queued: 1, oldestQueuedAt: 101_000 }, 100_000), /^codeharbor_index_queue_oldest_wait_seconds 0$/m);
});
