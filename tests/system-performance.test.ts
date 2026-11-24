import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectSystemPerformance, formatSystemPerformanceMetrics } from '../src/system-performance.js';

test('performance collection shares a CPU sample while reading each requested data filesystem', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codeharbor-metrics-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const [sample, missing] = await Promise.all([
    collectSystemPerformance(dir),
    collectSystemPerformance(join(dir, 'missing')),
  ]);
  assert.equal(typeof sample.sampledAt, 'string');
  assert.equal(sample.sampledAt, missing.sampledAt);
  assert.deepEqual(sample.process, missing.process);
  assert.ok(sample.process.cpuUsageCores !== null && sample.process.cpuUsageCores >= 0);
  assert.ok(sample.process.cpuSecondsTotal >= 0);
  assert.ok(sample.process.residentMemoryBytes > 0);
  assert.ok(sample.system.availableMemoryBytes >= 0);
  assert.ok(sample.system.availableMemoryBytes <= sample.system.totalMemoryBytes);
  assert.ok(
    sample.system.cpuUsageRatio === null || (sample.system.cpuUsageRatio >= 0 && sample.system.cpuUsageRatio <= 1),
  );
  assert.ok(sample.storage && sample.storage.totalBytes > 0);
  assert.equal(missing.storage, null);

  const rendered = formatSystemPerformanceMetrics({ ...missing, cgroup: null });
  assert.match(rendered, /^# TYPE codeharbor_process_cpu_seconds_total counter$/m);
  assert.match(rendered, /^codeharbor_process_cpu_usage_cores \d/m);
  assert.doesNotMatch(rendered, /codeharbor_(data_filesystem|cgroup)_/);
});
