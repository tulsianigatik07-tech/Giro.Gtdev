import type { CircuitDependency, CircuitState } from "../runtime/circuitBreaker.js";

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
export type RetryMetricCategory = "ai" | "embedding" | "database" | "clone";
export type RetryMetricResult = "scheduled" | "succeeded" | "exhausted";

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
  private readonly retries = new Map<string, { category: RetryMetricCategory; result: RetryMetricResult; attempt: number; value: number }>();
  private readonly circuitStates = new Map<CircuitDependency, CircuitState>();
  private readonly circuitTransitions = new Map<string, { dependency: CircuitDependency; from: CircuitState; to: CircuitState; value: number }>();
  private readonly circuitRejections = new Map<CircuitDependency, number>();
  private activeSseClients = 0;
  private publishedProgressEvents = 0;
  private readonly sseStreams = new Map<"completed" | "failed", number>([
    ["completed", 0],
    ["failed", 0],
  ]);
  private retrievalCacheHits = 0;
  private retrievalCacheMisses = 0;
  private retrievalCacheEvictions = 0;
  private retrievalCacheEntries = 0;
  private citationsGenerated = 0;
  private citationChunks = 0;
  private citationMerges = 0;
  private chunkStitches = 0;
  private chunksMerged = 0;
  private stitchBudgetDrops = 0;
  private queryExpansions = 0;
  private queryExpansionTerms = 0;
  private queryExpansionCacheHits = 0;
  private symbolGraphNodes = 0;
  private symbolGraphEdges = 0;
  private symbolExpansions = 0;
  private symbolExpansionBudgetDrops = 0;
  private repositorySummaries = 0;
  private repositorySummaryGenerationMs = 0;
  private repositorySummaryCacheHits = 0;

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

  incrementRetry(category: RetryMetricCategory, result: RetryMetricResult, attempt: number): void {
    const boundedAttempt = Math.min(6, Math.max(1, Math.trunc(attempt)));
    const key = `${category}:${result}:${boundedAttempt}`;
    const existing = this.retries.get(key);
    if (existing) existing.value += 1;
    else this.retries.set(key, { category, result, attempt: boundedAttempt, value: 1 });
  }

  setCircuitState(dependency: CircuitDependency, state: CircuitState): void {
    this.circuitStates.set(dependency, state);
  }

  incrementCircuitTransition(dependency: CircuitDependency, from: CircuitState, to: CircuitState): void {
    const key = `${dependency}:${from}:${to}`;
    const existing = this.circuitTransitions.get(key);
    if (existing) existing.value += 1;
    else this.circuitTransitions.set(key, { dependency, from, to, value: 1 });
  }

  incrementCircuitRejection(dependency: CircuitDependency): void {
    this.circuitRejections.set(dependency, (this.circuitRejections.get(dependency) ?? 0) + 1);
  }

  incrementActiveSseClients(): void {
    this.activeSseClients += 1;
  }

  decrementActiveSseClients(): void {
    this.activeSseClients = Math.max(0, this.activeSseClients - 1);
  }

  incrementPublishedProgressEvents(): void {
    this.publishedProgressEvents += 1;
  }

  incrementSseStreams(outcome: "completed" | "failed"): void {
    this.sseStreams.set(outcome, (this.sseStreams.get(outcome) ?? 0) + 1);
  }

  incrementRetrievalCacheHit(): void {
    this.retrievalCacheHits += 1;
  }

  incrementRetrievalCacheMiss(): void {
    this.retrievalCacheMisses += 1;
  }

  incrementRetrievalCacheEviction(): void {
    this.retrievalCacheEvictions += 1;
  }

  setRetrievalCacheEntries(entries: number): void {
    this.retrievalCacheEntries = Math.max(0, Math.trunc(entries));
  }

  incrementCitationsGenerated(): void {
    this.citationsGenerated += 1;
  }

  addCitationChunks(count: number): void {
    this.citationChunks += Math.max(0, Math.trunc(count));
  }

  addCitationMerges(count: number): void {
    this.citationMerges += Math.max(0, Math.trunc(count));
  }

  incrementChunkStitches(count = 1): void {
    this.chunkStitches += Math.max(0, Math.trunc(count));
  }

  incrementChunksMerged(count = 1): void {
    this.chunksMerged += Math.max(0, Math.trunc(count));
  }

  incrementStitchBudgetDrops(count = 1): void {
    this.stitchBudgetDrops += Math.max(0, Math.trunc(count));
  }

  incrementQueryExpansions(count = 1): void {
    this.queryExpansions += Math.max(0, Math.trunc(count));
  }

  incrementQueryExpansionTerms(count = 1): void {
    this.queryExpansionTerms += Math.max(0, Math.trunc(count));
  }

  incrementQueryExpansionCacheHits(count = 1): void {
    this.queryExpansionCacheHits += Math.max(0, Math.trunc(count));
  }

  setSymbolGraphSize(nodes: number, edges: number): void {
    this.symbolGraphNodes = Math.max(0, Math.trunc(nodes));
    this.symbolGraphEdges = Math.max(0, Math.trunc(edges));
  }

  incrementSymbolExpansion(count = 1): void {
    this.symbolExpansions += Math.max(0, Math.trunc(count));
  }

  incrementSymbolExpansionBudgetDrop(count = 1): void {
    this.symbolExpansionBudgetDrops += Math.max(0, Math.trunc(count));
  }

  incrementRepositorySummary(): void {
    this.repositorySummaries += 1;
  }

  observeRepositorySummaryGenerationMs(milliseconds: number): void {
    this.repositorySummaryGenerationMs = Math.max(0, Math.trunc(milliseconds));
  }

  incrementRepositorySummaryCacheHit(): void {
    this.repositorySummaryCacheHits += 1;
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
    lines.push(
      "# HELP giro_retries_total Retry policy outcomes.",
      "# TYPE giro_retries_total counter",
    );
    for (const metric of this.retries.values()) {
      lines.push(`giro_retries_total{category="${metric.category}",result="${metric.result}",attempt="${metric.attempt}"} ${metric.value}`);
    }
    lines.push(
      "# HELP giro_circuit_state Current dependency circuit state.",
      "# TYPE giro_circuit_state gauge",
    );
    for (const dependency of ["ai", "embedding", "database", "clone"] as const) {
      const active = this.circuitStates.get(dependency) ?? "closed";
      for (const state of ["closed", "open", "half_open"] as const) {
        lines.push(`giro_circuit_state{dependency="${dependency}",state="${state}"} ${active === state ? 1 : 0}`);
      }
    }
    lines.push(
      "# HELP giro_circuit_transitions_total Dependency circuit state transitions.",
      "# TYPE giro_circuit_transitions_total counter",
    );
    for (const metric of this.circuitTransitions.values()) {
      lines.push(`giro_circuit_transitions_total{dependency="${metric.dependency}",from="${metric.from}",to="${metric.to}"} ${metric.value}`);
    }
    lines.push(
      "# HELP giro_circuit_rejections_total Calls rejected by open dependency circuits.",
      "# TYPE giro_circuit_rejections_total counter",
    );
    for (const dependency of ["ai", "embedding", "database", "clone"] as const) {
      lines.push(`giro_circuit_rejections_total{dependency="${dependency}"} ${this.circuitRejections.get(dependency) ?? 0}`);
    }
    lines.push(
      "# HELP giro_indexing_sse_clients_active Current indexing SSE client connections.",
      "# TYPE giro_indexing_sse_clients_active gauge",
      `giro_indexing_sse_clients_active ${this.activeSseClients}`,
      "# HELP giro_indexing_progress_events_total Indexing progress events published.",
      "# TYPE giro_indexing_progress_events_total counter",
      `giro_indexing_progress_events_total ${this.publishedProgressEvents}`,
      "# HELP giro_indexing_sse_streams_total Indexing SSE streams closed by terminal outcome.",
      "# TYPE giro_indexing_sse_streams_total counter",
    );
    for (const outcome of ["completed", "failed"] as const) {
      lines.push(`giro_indexing_sse_streams_total{outcome="${outcome}"} ${this.sseStreams.get(outcome) ?? 0}`);
    }
    lines.push(
      "# HELP giro_retrieval_cache_hits_total Retrieval cache hits, including shared in-flight work.",
      "# TYPE giro_retrieval_cache_hits_total counter",
      `giro_retrieval_cache_hits_total ${this.retrievalCacheHits}`,
      "# HELP giro_retrieval_cache_misses_total Retrieval cache misses.",
      "# TYPE giro_retrieval_cache_misses_total counter",
      `giro_retrieval_cache_misses_total ${this.retrievalCacheMisses}`,
      "# HELP giro_retrieval_cache_evictions_total Retrieval cache TTL and capacity evictions.",
      "# TYPE giro_retrieval_cache_evictions_total counter",
      `giro_retrieval_cache_evictions_total ${this.retrievalCacheEvictions}`,
      "# HELP giro_retrieval_cache_entries Current retrieval cache entries.",
      "# TYPE giro_retrieval_cache_entries gauge",
      `giro_retrieval_cache_entries ${this.retrievalCacheEntries}`,
      "# HELP giro_citations_generated_total Citation sets generated from retrieved chunks.",
      "# TYPE giro_citations_generated_total counter",
      `giro_citations_generated_total ${this.citationsGenerated}`,
      "# HELP giro_citation_chunks_total Grounded citation chunks emitted.",
      "# TYPE giro_citation_chunks_total counter",
      `giro_citation_chunks_total ${this.citationChunks}`,
      "# HELP giro_citation_merge_total Duplicate citation locations merged.",
      "# TYPE giro_citation_merge_total counter",
      `giro_citation_merge_total ${this.citationMerges}`,
      "# HELP giro_chunk_stitches_total Adjacent chunk stitch groups created.",
      "# TYPE giro_chunk_stitches_total counter",
      `giro_chunk_stitches_total ${this.chunkStitches}`,
      "# HELP giro_chunks_merged_total Chunks contributing to stitched blocks.",
      "# TYPE giro_chunks_merged_total counter",
      `giro_chunks_merged_total ${this.chunksMerged}`,
      "# HELP giro_stitch_budget_drops_total Stitched blocks dropped by context budgets.",
      "# TYPE giro_stitch_budget_drops_total counter",
      `giro_stitch_budget_drops_total ${this.stitchBudgetDrops}`,
      "# HELP giro_query_expansions_total Repository-aware query expansions computed.",
      "# TYPE giro_query_expansions_total counter",
      `giro_query_expansions_total ${this.queryExpansions}`,
      "# HELP giro_query_expansion_terms_total Expanded retrieval terms generated.",
      "# TYPE giro_query_expansion_terms_total counter",
      `giro_query_expansion_terms_total ${this.queryExpansionTerms}`,
      "# HELP giro_query_expansion_cache_hits_total Query expansion cache hits.",
      "# TYPE giro_query_expansion_cache_hits_total counter",
      `giro_query_expansion_cache_hits_total ${this.queryExpansionCacheHits}`,
      "# HELP giro_symbol_graph_nodes Repository symbol graph nodes.",
      "# TYPE giro_symbol_graph_nodes gauge",
      `giro_symbol_graph_nodes ${this.symbolGraphNodes}`,
      "# HELP giro_symbol_graph_edges Repository symbol graph edges.",
      "# TYPE giro_symbol_graph_edges gauge",
      `giro_symbol_graph_edges ${this.symbolGraphEdges}`,
      "# HELP giro_symbol_expansions_total Retrieval chunks added by symbol graph expansion.",
      "# TYPE giro_symbol_expansions_total counter",
      `giro_symbol_expansions_total ${this.symbolExpansions}`,
      "# HELP giro_symbol_expansion_budget_drops_total Symbol graph expansions dropped by context budget.",
      "# TYPE giro_symbol_expansion_budget_drops_total counter",
      `giro_symbol_expansion_budget_drops_total ${this.symbolExpansionBudgetDrops}`,
      "# HELP giro_repository_summaries_total Repository architecture summaries generated.",
      "# TYPE giro_repository_summaries_total counter",
      `giro_repository_summaries_total ${this.repositorySummaries}`,
      "# HELP giro_repository_summary_generation_ms Last repository architecture summary generation duration in milliseconds.",
      "# TYPE giro_repository_summary_generation_ms gauge",
      `giro_repository_summary_generation_ms ${this.repositorySummaryGenerationMs}`,
      "# HELP giro_repository_summary_cache_hits_total Repository architecture summary cache hits.",
      "# TYPE giro_repository_summary_cache_hits_total counter",
      `giro_repository_summary_cache_hits_total ${this.repositorySummaryCacheHits}`,
    );
    return `${lines.join("\n")}\n`;
  }
}

export const runtimeMetrics = new MetricsRegistry();
