const DEFAULT_DURATION_BUCKETS_SECONDS = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
] as const;

export type IndexingMetricStatus = "started" | "completed" | "failed";
export type TimeoutMetricCategory = "request" | "ai" | "embedding" | "database" | "clone" | "indexing";

export interface MetricsRegistryOptions {
  durationBucketsSeconds?: readonly number[];
}

type HttpCounterLabels = {
  route: string;
  method: string;
  statusClass: string;
};

type HistogramValue = {
  buckets: number[];
  count: number;
  sum: number;
};

function validateBuckets(input: readonly number[]): number[] {
  if (
    input.length === 0 ||
    input.some((value) => !Number.isFinite(value) || value <= 0) ||
    input.some((value, index) => index > 0 && value <= (input[index - 1] ?? 0))
  ) {
    throw new TypeError("durationBucketsSeconds must contain increasing positive numbers");
  }
  return [...input];
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labels(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(",");
}

function finiteMetricValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

export class MetricsRegistry {
  readonly durationBucketsSeconds: readonly number[];
  private readonly httpRequests = new Map<string, { labels: HttpCounterLabels; value: number }>();
  private readonly httpDurations = new Map<string, { route: string; method: string; value: HistogramValue }>();
  private readonly indexing = new Map<IndexingMetricStatus, number>([
    ["started", 0],
    ["completed", 0],
    ["failed", 0],
  ]);
  private inFlight = 0;
  private rateLimitRejections = 0;
  private readiness = 0;
  private readonly timeouts = new Map<TimeoutMetricCategory, number>();

  constructor(options: MetricsRegistryOptions = {}) {
    this.durationBucketsSeconds = Object.freeze(validateBuckets(
      options.durationBucketsSeconds ?? DEFAULT_DURATION_BUCKETS_SECONDS,
    ));
  }

  incrementHttpRequests(input: HttpCounterLabels): void {
    const key = JSON.stringify([input.route, input.method, input.statusClass]);
    const existing = this.httpRequests.get(key);
    if (existing) existing.value += 1;
    else this.httpRequests.set(key, { labels: { ...input }, value: 1 });
  }

  observeHttpDuration(route: string, method: string, seconds: number): void {
    const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const key = JSON.stringify([route, method]);
    let entry = this.httpDurations.get(key);
    if (!entry) {
      entry = {
        route,
        method,
        value: {
          buckets: this.durationBucketsSeconds.map(() => 0),
          count: 0,
          sum: 0,
        },
      };
      this.httpDurations.set(key, entry);
    }
    entry.value.count += 1;
    entry.value.sum += safeSeconds;
    this.durationBucketsSeconds.forEach((upperBound, index) => {
      if (safeSeconds <= upperBound) {
        entry!.value.buckets[index] = (entry!.value.buckets[index] ?? 0) + 1;
      }
    });
  }

  incrementInFlight(): void {
    this.inFlight += 1;
  }

  decrementInFlight(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  incrementRateLimitRejections(): void {
    this.rateLimitRejections += 1;
  }

  incrementIndexing(status: IndexingMetricStatus): void {
    this.indexing.set(status, (this.indexing.get(status) ?? 0) + 1);
  }

  setReadiness(ready: boolean): void {
    this.readiness = ready ? 1 : 0;
  }

  incrementTimeout(category: TimeoutMetricCategory): void {
    this.timeouts.set(category, (this.timeouts.get(category) ?? 0) + 1);
  }

  render(): string {
    const lines = [
      "# HELP giro_http_requests_total Total HTTP requests.",
      "# TYPE giro_http_requests_total counter",
    ];
    for (const metric of this.httpRequests.values()) {
      lines.push(`giro_http_requests_total{${labels({
        route: metric.labels.route,
        method: metric.labels.method,
        status_class: metric.labels.statusClass,
      })}} ${metric.value}`);
    }

    lines.push(
      "# HELP giro_http_request_duration_seconds HTTP request duration in seconds.",
      "# TYPE giro_http_request_duration_seconds histogram",
    );
    for (const metric of this.httpDurations.values()) {
      const baseLabels = { route: metric.route, method: metric.method };
      this.durationBucketsSeconds.forEach((upperBound, index) => {
        lines.push(`giro_http_request_duration_seconds_bucket{${labels({
          ...baseLabels,
          le: String(upperBound),
        })}} ${metric.value.buckets[index]}`);
      });
      lines.push(`giro_http_request_duration_seconds_bucket{${labels({ ...baseLabels, le: "+Inf" })}} ${metric.value.count}`);
      lines.push(`giro_http_request_duration_seconds_sum{${labels(baseLabels)}} ${finiteMetricValue(metric.value.sum)}`);
      lines.push(`giro_http_request_duration_seconds_count{${labels(baseLabels)}} ${metric.value.count}`);
    }

    lines.push(
      "# HELP giro_http_requests_in_flight Current HTTP requests being processed.",
      "# TYPE giro_http_requests_in_flight gauge",
      `giro_http_requests_in_flight ${this.inFlight}`,
      "# HELP giro_rate_limit_rejections_total Requests rejected by rate limiting.",
      "# TYPE giro_rate_limit_rejections_total counter",
      `giro_rate_limit_rejections_total ${this.rateLimitRejections}`,
      "# HELP giro_repository_indexing_total Repository indexing lifecycle events.",
      "# TYPE giro_repository_indexing_total counter",
    );
    for (const [status, value] of this.indexing) {
      lines.push(`giro_repository_indexing_total{status="${status}"} ${value}`);
    }
    lines.push(
      "# HELP giro_health_readiness Application readiness state (1 ready, 0 not ready).",
      "# TYPE giro_health_readiness gauge",
      `giro_health_readiness ${this.readiness}`,
      "# HELP giro_timeouts_total Deadline and upstream timeout events.",
      "# TYPE giro_timeouts_total counter",
    );
    for (const category of ["request", "ai", "embedding", "database", "clone", "indexing"] as const) {
      lines.push(`giro_timeouts_total{category="${category}"} ${this.timeouts.get(category) ?? 0}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

export const runtimeMetrics = new MetricsRegistry();
