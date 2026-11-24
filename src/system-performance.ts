import { readFile, statfs } from 'node:fs/promises';
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os';
import { join, relative } from 'node:path';
import { cpuUsage, memoryUsage, platform, uptime as processUptime } from 'node:process';
import { setTimeout } from 'node:timers/promises';

export type SystemPerformance = {
  sampledAt: string;
  system: {
    cpuCount: number;
    cpuUsageRatio: number | null;
    loadAverage: { oneMinute: number; fiveMinutes: number; fifteenMinutes: number } | null;
    totalMemoryBytes: number;
    availableMemoryBytes: number;
    uptimeSeconds: number;
  };
  cgroup: {
    cpuUsageCores: number | null;
    cpuSecondsTotal: number | null;
    cpuLimitCores: number | null;
    memoryUsageBytes: number | null;
    memoryLimitBytes: number | null;
  } | null;
  process: {
    uptimeSeconds: number;
    residentMemoryBytes: number;
    cpuUsageCores: number | null;
    cpuSecondsTotal: number;
  };
  storage: { totalBytes: number; availableBytes: number } | null;
};

const CPU_SAMPLE_MS = 250;
const RESOURCE_CACHE_MS = 1_000;

let resourceSample: { expiresAt: number; result: Promise<Omit<SystemPerformance, 'storage'>> } | undefined;

async function readOptional(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch(() => undefined);
}

function parseUnsignedInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function cgroupDirectory(): Promise<string | null> {
  if (platform !== 'linux') return null;
  const [membership, mounts] = await Promise.all([
    readOptional('/proc/self/cgroup'),
    readOptional('/proc/self/mountinfo'),
  ]);
  const path = membership?.match(/^0::(\/[^\n]*)$/m)?.[1];
  if (!path || path.split('/').includes('..')) return null;
  for (const mount of mounts?.split('\n') ?? []) {
    const [details, fileSystem] = mount.split(' - ');
    if (!fileSystem?.startsWith('cgroup2 ')) continue;
    const [, , , root, mountPoint] = details.split(' ');
    const decode = (value: string) =>
      value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    const subpath = relative(decode(root), path);
    if (subpath !== '..' && !subpath.startsWith('../')) return join(decode(mountPoint), subpath);
  }
  return null;
}

async function cpuSnapshot(cgroup: string | null) {
  const cgroupStats = cgroup ? await readOptional(join(cgroup, 'cpu.stat')) : undefined;
  const cgroupMicros = parseUnsignedInteger(cgroupStats?.match(/^usage_usec\s+(\d+)$/m)?.[1]);
  const processCpu = cpuUsage();
  const logicalCpus = cpus();
  let busy = 0;
  let idle = 0;
  for (const { times } of logicalCpus) {
    busy += times.user + times.nice + times.sys + times.irq;
    idle += times.idle;
  }
  return {
    takenAt: performance.now(),
    cpuCount: logicalCpus.length,
    busy,
    idle,
    processSeconds: (processCpu.user + processCpu.system) / 1e6,
    cgroupSeconds: cgroupMicros === null ? null : cgroupMicros / 1e6,
  };
}

function cpuCores(start: number | null, end: number | null, elapsedSeconds: number): number | null {
  return start === null || end === null || end < start || elapsedSeconds <= 0 ? null : (end - start) / elapsedSeconds;
}

async function cgroupLimits(directory: string | null) {
  if (directory === null) return null;
  const [cpuMax, memoryUsage, memoryMax] = await Promise.all([
    readOptional(join(directory, 'cpu.max')),
    readOptional(join(directory, 'memory.current')),
    readOptional(join(directory, 'memory.max')),
  ]);
  const [quota, period] = cpuMax?.trim().split(/\s+/).map(parseUnsignedInteger) ?? [];
  return {
    cpuLimitCores: quota && period ? quota / period : null,
    memoryUsageBytes: parseUnsignedInteger(memoryUsage?.trim()),
    memoryLimitBytes: parseUnsignedInteger(memoryMax?.trim()),
  };
}

async function availableMemory(): Promise<number> {
  const meminfo = platform === 'linux' ? await readOptional('/proc/meminfo') : undefined;
  const kibibytes = parseUnsignedInteger(meminfo?.match(/^MemAvailable:\s+(\d+)\s+kB$/m)?.[1]);
  return kibibytes === null ? freemem() : kibibytes * 1024;
}

async function collectResources(): Promise<Omit<SystemPerformance, 'storage'>> {
  const cgroup = await cgroupDirectory();
  const before = await cpuSnapshot(cgroup);
  const [, limits, availableMemoryBytes] = await Promise.all([
    setTimeout(CPU_SAMPLE_MS),
    cgroupLimits(cgroup),
    availableMemory(),
  ]);
  const after = await cpuSnapshot(cgroup);
  const busy = after.busy - before.busy;
  const idle = after.idle - before.idle;
  const usageRatio =
    before.cpuCount === after.cpuCount && busy >= 0 && idle >= 0 && busy + idle > 0 ? busy / (busy + idle) : null;
  const elapsedSeconds = (after.takenAt - before.takenAt) / 1000;
  const [oneMinute, fiveMinutes, fifteenMinutes] = loadavg();
  const totalMemoryBytes = totalmem();
  return {
    sampledAt: new Date().toISOString(),
    system: {
      cpuCount: after.cpuCount,
      cpuUsageRatio: usageRatio,
      loadAverage: platform === 'win32' ? null : { oneMinute, fiveMinutes, fifteenMinutes },
      totalMemoryBytes,
      availableMemoryBytes: Math.min(totalMemoryBytes, availableMemoryBytes),
      uptimeSeconds: uptime(),
    },
    cgroup: limits && {
      ...limits,
      cpuUsageCores: cpuCores(before.cgroupSeconds, after.cgroupSeconds, elapsedSeconds),
      cpuSecondsTotal: after.cgroupSeconds,
    },
    process: {
      uptimeSeconds: processUptime(),
      residentMemoryBytes: memoryUsage.rss(),
      cpuUsageCores: cpuCores(before.processSeconds, after.processSeconds, elapsedSeconds),
      cpuSecondsTotal: after.processSeconds,
    },
  };
}

export async function collectSystemPerformance(dataDir: string): Promise<SystemPerformance> {
  if (!resourceSample || resourceSample.expiresAt <= performance.now()) {
    const pending = { expiresAt: Infinity, result: collectResources() };
    resourceSample = pending;
    pending.result.then(
      () => {
        pending.expiresAt = performance.now() + RESOURCE_CACHE_MS;
      },
      () => {
        pending.expiresAt = 0;
      },
    );
  }
  const [resources, filesystem] = await Promise.all([resourceSample.result, statfs(dataDir).catch(() => null)]);
  return {
    ...resources,
    storage: filesystem && {
      totalBytes: filesystem.blocks * filesystem.bsize,
      availableBytes: filesystem.bavail * filesystem.bsize,
    },
  };
}

export function formatSystemPerformanceMetrics({ system, cgroup, process, storage }: SystemPerformance): string {
  const output: string[] = [];
  const append = (name: string, help: string, value: number | null | undefined, type = 'gauge') => {
    if (value === null || value === undefined) return;
    const metric = `codeharbor_${name}`;
    output.push(`# HELP ${metric} ${help}`, `# TYPE ${metric} ${type}`, `${metric} ${value}`);
  };
  append('system_cpu_logical_cores', 'Logical CPU cores visible to the operating system.', system.cpuCount);
  append('system_cpu_usage_ratio', 'Sampled fraction of OS-visible CPU time spent busy.', system.cpuUsageRatio);
  if (system.loadAverage) {
    output.push(
      '# HELP codeharbor_system_load_average OS-visible load average by window.',
      '# TYPE codeharbor_system_load_average gauge',
      `codeharbor_system_load_average{window="1m"} ${system.loadAverage.oneMinute}`,
      `codeharbor_system_load_average{window="5m"} ${system.loadAverage.fiveMinutes}`,
      `codeharbor_system_load_average{window="15m"} ${system.loadAverage.fifteenMinutes}`,
    );
  }
  append('system_memory_total_bytes', 'Total bytes of OS-visible memory.', system.totalMemoryBytes);
  append(
    'system_memory_available_bytes',
    'Available bytes of OS-visible memory (free if unavailable).',
    system.availableMemoryBytes,
  );
  append('system_uptime_seconds', 'OS-visible uptime in seconds.', system.uptimeSeconds);
  append('cgroup_cpu_usage_cores', 'Sampled CPU cores in use by the service cgroup.', cgroup?.cpuUsageCores);
  append(
    'cgroup_cpu_seconds_total',
    'Cumulative CPU time in seconds for the service cgroup.',
    cgroup?.cpuSecondsTotal,
    'counter',
  );
  append('cgroup_cpu_limit_cores', 'CPU quota in cores for the service cgroup.', cgroup?.cpuLimitCores);
  append(
    'cgroup_memory_usage_bytes',
    'Bytes of memory currently accounted to the service cgroup.',
    cgroup?.memoryUsageBytes,
  );
  append(
    'cgroup_memory_limit_bytes',
    'Configured hard memory limit in bytes for the service cgroup.',
    cgroup?.memoryLimitBytes,
  );
  append('process_cpu_usage_cores', 'Sampled CPU cores in use by the CodeHarbor process.', process.cpuUsageCores);
  append(
    'process_cpu_seconds_total',
    'Cumulative CPU time in seconds for the CodeHarbor process.',
    process.cpuSecondsTotal,
    'counter',
  );
  append(
    'process_resident_memory_bytes',
    'Resident memory of the CodeHarbor process in bytes.',
    process.residentMemoryBytes,
  );
  append('process_uptime_seconds', 'CodeHarbor process uptime in seconds.', process.uptimeSeconds);
  append(
    'data_filesystem_total_bytes',
    'Total bytes on the filesystem containing the CodeHarbor data directory.',
    storage?.totalBytes,
  );
  append(
    'data_filesystem_available_bytes',
    'Bytes available to unprivileged users on the CodeHarbor data filesystem.',
    storage?.availableBytes,
  );
  return `${output.join('\n')}\n`;
}
