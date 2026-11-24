const DURATION_BUCKETS_S = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

type Series = { method: string; status: number; count: number; seconds: number; buckets: number[] };

/** Prometheus text exposition for HTTP traffic; labels are bounded to method and status class. */
export class HttpMetrics {
  private readonly series = new Map<string, Series>();

  observe(method: string, status: number, seconds: number): void {
    const normalizedMethod = METHODS.has(method) ? method : 'OTHER';
    const code = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
    const id = `${normalizedMethod}:${code}`;
    const row = this.series.get(id) ?? {
      method: normalizedMethod,
      status: code,
      count: 0,
      seconds: 0,
      buckets: DURATION_BUCKETS_S.map(() => 0),
    };
    row.count++;
    row.seconds += seconds;
    DURATION_BUCKETS_S.forEach((limit, index) => {
      if (seconds <= limit) row.buckets[index]++;
    });
    this.series.set(id, row);
  }

  render(extra: { fenced: Record<string, boolean>; audit?: { dropped: number; failed: number } }): string {
    const output = [
      '# HELP codeharbor_http_requests_total HTTP requests.',
      '# TYPE codeharbor_http_requests_total counter',
    ];
    for (const row of this.series.values()) {
      output.push(`codeharbor_http_requests_total{method="${row.method}",status="${row.status}"} ${row.count}`);
    }
    output.push(
      '# HELP codeharbor_http_request_duration_seconds HTTP request duration.',
      '# TYPE codeharbor_http_request_duration_seconds histogram',
    );
    for (const row of this.series.values()) {
      const labels = `method="${row.method}",status="${row.status}"`;
      DURATION_BUCKETS_S.forEach((limit, index) => {
        output.push(`codeharbor_http_request_duration_seconds_bucket{${labels},le="${limit}"} ${row.buckets[index]}`);
      });
      output.push(
        `codeharbor_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${row.count}`,
        `codeharbor_http_request_duration_seconds_sum{${labels}} ${row.seconds}`,
        `codeharbor_http_request_duration_seconds_count{${labels}} ${row.count}`,
      );
    }
    output.push(
      '# HELP codeharbor_runtime_fenced Fail-closed runtime fences requiring operator intervention.',
      '# TYPE codeharbor_runtime_fenced gauge',
    );
    for (const [component, value] of Object.entries(extra.fenced)) {
      if (/^[a-z_]+$/.test(component))
        output.push(`codeharbor_runtime_fenced{component="${component}"} ${value ? 1 : 0}`);
    }
    if (extra.audit) {
      output.push(
        '# HELP codeharbor_audit_dropped_total Audit events dropped because the buffer was full.',
        '# TYPE codeharbor_audit_dropped_total counter',
        `codeharbor_audit_dropped_total ${extra.audit.dropped}`,
        '# HELP codeharbor_audit_failed_total Audit events that could not be persisted.',
        '# TYPE codeharbor_audit_failed_total counter',
        `codeharbor_audit_failed_total ${extra.audit.failed}`,
      );
    }
    return `${output.join('\n')}\n`;
  }
}
