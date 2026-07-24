import type { CircuitDependency, CircuitState } from "../runtime/circuitBreaker.js";
import type {
  RetrievalConfidenceLevel,
  RetrievalConfidenceReasonCode,
} from "../services/retrieval/confidence/confidenceTypes.js";

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
  processStartTimeSeconds?: number;
  uptimeSeconds?: () => number;
  memoryUsage?: () => Pick<NodeJS.MemoryUsage, "rss" | "heapTotal" | "heapUsed" | "external">;
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
  private totalRequests = 0;
  private completedRequests = 0;
  private failedRequests = 0;
  private requestDurationCount = 0;
  private requestDurationTotalMs = 0;
  private readonly requestDurationSamplesMs: number[] = [];
  private readonly requestDurationWindowMs: number[] = [];
  private requestDurationSampleCursor = 0;
  private requestDurationP50Ms = 0;
  private requestDurationP95Ms = 0;
  private requestDurationP99Ms = 0;
  private rateLimitRejections = 0;
  private repositoryConnects = 0;
  private askGiroRequests = 0;
  private retrievalRequests = 0;
  private readiness = 0;
  private readinessInitialized = false;
  private readinessTransitions = 0;
  private workerDatabaseFailures = 0;
  private workerConsecutiveDatabaseFailures = 0;
  private workerLastSuccessfulPollSeconds = 0;
  private workerLastSuccessfulClaimSeconds = 0;
  private workerStalled = 0;
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
  private rankingOperations = 0;
  private rankingCandidates = 0;
  private rankingDurationMs = 0;
  private readonly retrievalConfidence = new Map<RetrievalConfidenceLevel, number>();
  private readonly retrievalAnswerability = new Map<"true" | "false", number>();
  private readonly retrievalInsufficientEvidence = new Map<RetrievalConfidenceReasonCode, number>();
  private symbolGraphNodes = 0;
  private symbolGraphEdges = 0;
  private symbolExpansions = 0;
  private symbolExpansionBudgetDrops = 0;
  private graphParsedFiles = 0;
  private graphParserFailures = 0;
  private graphUnresolvedImports = 0;
  private graphPublicationFailures = 0;
  private graphExpansionUsage = 0;
  private graphExpandedCandidates = 0;
  private graphRetrievalDurationMs = 0;
  private repositorySummaries = 0;
  private repositorySummaryGenerationMs = 0;
  private repositorySummaryCacheHits = 0;
  private intelligenceAnalysisDurationMs = 0;
  private intelligenceGeneratedSubsystems = 0;
  private intelligenceDependencyEdges = 0;
  private intelligenceQualityFindings = 0;
  private intelligenceHotspots = 0;
  private retrievalIntelligenceUsage = 0;
  private intelligencePublicationFailures = 0;
  private repositoryPlanningDurationMs = 0;
  private repositoryPlanningPhases = 0;
  private repositoryPlanningDependencies = 0;
  private repositoryPlanningRiskScore = 0;
  private repositoryPlannerFailures = 0;
  private repositoryPlanningRetrievalContribution = 0;
  private executionRunsCreated = 0;
  private executionApprovals = 0;
  private executionActiveRuns = 0;
  private executionReadyUnits = 0;
  private executionBlockedUnits = 0;
  private executionRunningUnits = 0;
  private executionLeaseRecoveries = 0;
  private executionRetries = 0;
  private executionFailures = 0;
  private executionReviewLatencyMs = 0;
  private executionRunDurationMs = 0;
  private executionCriticalPathDurationMs = 0;
  private readonly processStartTimeSeconds: number;
  private readonly uptimeSeconds: () => number;
  private readonly memoryUsage: MetricsRegistryOptions["memoryUsage"];

  constructor(options: MetricsRegistryOptions = {}) {
    this.durationBucketsSeconds = Object.freeze(validateBuckets(
      options.durationBucketsSeconds ?? DEFAULT_DURATION_BUCKETS_SECONDS,
    ));
    this.processStartTimeSeconds = options.processStartTimeSeconds ??
      Math.floor(Date.now() / 1_000 - process.uptime());
    this.uptimeSeconds = options.uptimeSeconds ?? process.uptime;
    this.memoryUsage = options.memoryUsage ?? process.memoryUsage;
  }

  beginRequest(): void {
    this.totalRequests += 1;
    this.inFlight += 1;
  }

  completeRequest(input: HttpCounterLabels & { status: number; durationMs: number }): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.completedRequests += 1;
    if (input.status >= 400) this.failedRequests += 1;
    this.incrementHttpRequests(input);
    this.observeHttpDuration(input.route, input.method, input.durationMs / 1_000);
    this.observeAggregateRequestDuration(input.durationMs);
  }

  private observeAggregateRequestDuration(milliseconds: number): void {
    const safeMilliseconds = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
    this.requestDurationCount += 1;
    this.requestDurationTotalMs += safeMilliseconds;
    const sampleLimit = 512;
    if (this.requestDurationWindowMs.length < sampleLimit) {
      this.requestDurationWindowMs.push(safeMilliseconds);
    } else {
      const replaced = this.requestDurationWindowMs[this.requestDurationSampleCursor] ?? 0;
      this.requestDurationWindowMs[this.requestDurationSampleCursor] = safeMilliseconds;
      this.requestDurationSampleCursor = (this.requestDurationSampleCursor + 1) % sampleLimit;
      const removalIndex = this.requestDurationSamplesMs.indexOf(replaced);
      if (removalIndex >= 0) this.requestDurationSamplesMs.splice(removalIndex, 1);
    }
    let insertionIndex = 0;
    while (
      insertionIndex < this.requestDurationSamplesMs.length &&
      (this.requestDurationSamplesMs[insertionIndex] ?? 0) <= safeMilliseconds
    ) {
      insertionIndex += 1;
    }
    this.requestDurationSamplesMs.splice(insertionIndex, 0, safeMilliseconds);
    const percentile = (quantile: number) =>
      this.requestDurationSamplesMs[
        Math.max(0, Math.ceil(this.requestDurationSamplesMs.length * quantile) - 1)
      ] ?? 0;
    this.requestDurationP50Ms = percentile(0.5);
    this.requestDurationP95Ms = percentile(0.95);
    this.requestDurationP99Ms = percentile(0.99);
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

  incrementRepositoryConnects(): void {
    this.repositoryConnects += 1;
  }

  incrementAskGiroRequests(): void {
    this.askGiroRequests += 1;
  }

  incrementRetrievalRequests(): void {
    this.retrievalRequests += 1;
  }

  incrementIndexing(status: IndexingMetricStatus): void {
    this.indexing.set(status, (this.indexing.get(status) ?? 0) + 1);
  }

  setReadiness(ready: boolean): void {
    const next = ready ? 1 : 0;
    if (this.readinessInitialized && this.readiness !== next) this.readinessTransitions += 1;
    this.readinessInitialized = true;
    this.readiness = next;
  }

  recordWorkerDatabaseFailure(consecutiveFailures: number): void {
    this.workerDatabaseFailures += 1;
    this.workerConsecutiveDatabaseFailures = Math.max(0, Math.trunc(consecutiveFailures));
  }

  recordWorkerDatabaseSuccess(kind: "poll" | "claim", timestampMs: number): void {
    this.workerConsecutiveDatabaseFailures = 0;
    const seconds = Math.max(0, timestampMs / 1_000);
    if (kind === "poll") this.workerLastSuccessfulPollSeconds = seconds;
    else this.workerLastSuccessfulClaimSeconds = seconds;
  }

  setWorkerStalled(stalled: boolean): void {
    this.workerStalled = stalled ? 1 : 0;
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

  incrementRankingOperations(count = 1): void {
    this.rankingOperations += Math.max(0, Math.trunc(count));
  }

  incrementRankingCandidates(count = 1): void {
    this.rankingCandidates += Math.max(0, Math.trunc(count));
  }

  observeRankingDurationMs(milliseconds: number): void {
    this.rankingDurationMs = Math.min(60_000, Math.max(0, milliseconds));
  }

  incrementRetrievalConfidence(level: RetrievalConfidenceLevel): void {
    this.retrievalConfidence.set(level, (this.retrievalConfidence.get(level) ?? 0) + 1);
  }

  incrementRetrievalAnswerability(answerable: boolean): void {
    const label = answerable ? "true" : "false";
    this.retrievalAnswerability.set(label, (this.retrievalAnswerability.get(label) ?? 0) + 1);
  }

  incrementRetrievalInsufficientEvidence(reason: RetrievalConfidenceReasonCode): void {
    this.retrievalInsufficientEvidence.set(
      reason,
      (this.retrievalInsufficientEvidence.get(reason) ?? 0) + 1,
    );
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

  incrementGraphParsedFiles(count = 1): void {
    this.graphParsedFiles += Math.max(0, Math.trunc(count));
  }

  incrementGraphParserFailures(count = 1): void {
    this.graphParserFailures += Math.max(0, Math.trunc(count));
  }

  incrementGraphUnresolvedImports(count = 1): void {
    this.graphUnresolvedImports += Math.max(0, Math.trunc(count));
  }

  incrementGraphPublicationFailures(count = 1): void {
    this.graphPublicationFailures += Math.max(0, Math.trunc(count));
  }

  incrementGraphExpansionUsage(count = 1): void {
    this.graphExpansionUsage += Math.max(0, Math.trunc(count));
  }

  incrementGraphExpandedCandidates(count = 1): void {
    this.graphExpandedCandidates += Math.max(0, Math.trunc(count));
  }

  observeGraphRetrievalDurationMs(milliseconds: number): void {
    this.graphRetrievalDurationMs = Math.min(60_000, Math.max(0, milliseconds));
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

  recordRepositoryIntelligenceAnalysis(input: {
    durationMs: number;
    generatedSubsystems: number;
    dependencyEdges: number;
    qualityFindings: number;
    hotspots: number;
  }): void {
    this.intelligenceAnalysisDurationMs += Math.max(0, input.durationMs);
    this.intelligenceGeneratedSubsystems += Math.max(0, Math.trunc(input.generatedSubsystems));
    this.intelligenceDependencyEdges += Math.max(0, Math.trunc(input.dependencyEdges));
    this.intelligenceQualityFindings += Math.max(0, Math.trunc(input.qualityFindings));
    this.intelligenceHotspots += Math.max(0, Math.trunc(input.hotspots));
  }

  incrementRetrievalIntelligenceUsage(count = 1): void {
    this.retrievalIntelligenceUsage += Math.max(0, Math.trunc(count));
  }

  incrementIntelligencePublicationFailures(count = 1): void {
    this.intelligencePublicationFailures += Math.max(0, Math.trunc(count));
  }

  recordRepositoryPlanning(input: {
    durationMs: number;
    phaseCount: number;
    dependencyCount: number;
    riskScore: number;
    retrievalContribution: number;
  }): void {
    this.repositoryPlanningDurationMs += Math.max(0, input.durationMs);
    this.repositoryPlanningPhases += Math.max(0, Math.trunc(input.phaseCount));
    this.repositoryPlanningDependencies += Math.max(0, Math.trunc(input.dependencyCount));
    this.repositoryPlanningRiskScore += Math.max(0, Math.min(1, input.riskScore));
    this.repositoryPlanningRetrievalContribution += Math.max(0, Math.trunc(input.retrievalContribution));
  }

  incrementRepositoryPlannerFailures(count = 1): void {
    this.repositoryPlannerFailures += Math.max(0, Math.trunc(count));
  }

  recordRepositoryExecution(input: {
    created?: number;
    approvals?: number;
    activeRuns?: number;
    readyUnits?: number;
    blockedUnits?: number;
    runningUnits?: number;
    leaseRecoveries?: number;
    retries?: number;
    failures?: number;
    reviewLatencyMs?: number;
    runDurationMs?: number;
    criticalPathDurationMs?: number;
  }): void {
    this.executionRunsCreated += Math.max(0, Math.trunc(input.created ?? 0));
    this.executionApprovals += Math.max(0, Math.trunc(input.approvals ?? 0));
    this.executionActiveRuns = Math.max(0, Math.trunc(input.activeRuns ?? this.executionActiveRuns));
    this.executionReadyUnits = Math.max(0, Math.trunc(input.readyUnits ?? this.executionReadyUnits));
    this.executionBlockedUnits = Math.max(0, Math.trunc(input.blockedUnits ?? this.executionBlockedUnits));
    this.executionRunningUnits = Math.max(0, Math.trunc(input.runningUnits ?? this.executionRunningUnits));
    this.executionLeaseRecoveries += Math.max(0, Math.trunc(input.leaseRecoveries ?? 0));
    this.executionRetries += Math.max(0, Math.trunc(input.retries ?? 0));
    this.executionFailures += Math.max(0, Math.trunc(input.failures ?? 0));
    this.executionReviewLatencyMs += Math.max(0, input.reviewLatencyMs ?? 0);
    this.executionRunDurationMs += Math.max(0, input.runDurationMs ?? 0);
    this.executionCriticalPathDurationMs += Math.max(0, input.criticalPathDurationMs ?? 0);
  }

  render(): string {
    const memory = this.memoryUsage?.() ?? process.memoryUsage();
    const averageDurationMs = this.requestDurationCount === 0
      ? 0
      : this.requestDurationTotalMs / this.requestDurationCount;
    const lines = [
      "# HELP giro_requests_total Total requests accepted by the backend.",
      "# TYPE giro_requests_total counter",
      `giro_requests_total ${this.totalRequests}`,
      "# HELP giro_requests_active Requests currently being processed.",
      "# TYPE giro_requests_active gauge",
      `giro_requests_active ${this.inFlight}`,
      "# HELP giro_requests_completed_total Requests that finished processing.",
      "# TYPE giro_requests_completed_total counter",
      `giro_requests_completed_total ${this.completedRequests}`,
      "# HELP giro_requests_failed_total Completed requests with HTTP status 4xx or 5xx.",
      "# TYPE giro_requests_failed_total counter",
      `giro_requests_failed_total ${this.failedRequests}`,
      "# HELP giro_requests_timed_out_total Requests completed by the application timeout.",
      "# TYPE giro_requests_timed_out_total counter",
      `giro_requests_timed_out_total ${this.timeouts.get("request") ?? 0}`,
      "# HELP giro_requests_rate_limited_total Requests rejected by rate limiting.",
      "# TYPE giro_requests_rate_limited_total counter",
      `giro_requests_rate_limited_total ${this.rateLimitRejections}`,
      "# HELP giro_repository_connects_total Repository connect requests.",
      "# TYPE giro_repository_connects_total counter",
      `giro_repository_connects_total ${this.repositoryConnects}`,
      "# HELP giro_indexing_jobs_started_total Indexing jobs started.",
      "# TYPE giro_indexing_jobs_started_total counter",
      `giro_indexing_jobs_started_total ${this.indexing.get("started") ?? 0}`,
      "# HELP giro_indexing_jobs_completed_total Indexing jobs completed successfully.",
      "# TYPE giro_indexing_jobs_completed_total counter",
      `giro_indexing_jobs_completed_total ${this.indexing.get("completed") ?? 0}`,
      "# HELP giro_indexing_jobs_failed_total Indexing jobs that failed.",
      "# TYPE giro_indexing_jobs_failed_total counter",
      `giro_indexing_jobs_failed_total ${this.indexing.get("failed") ?? 0}`,
      "# HELP giro_ask_giro_requests_total Ask Giro requests.",
      "# TYPE giro_ask_giro_requests_total counter",
      `giro_ask_giro_requests_total ${this.askGiroRequests}`,
      "# HELP giro_retrieval_requests_total Retrieval endpoint requests.",
      "# TYPE giro_retrieval_requests_total counter",
      `giro_retrieval_requests_total ${this.retrievalRequests}`,
      "# HELP giro_request_duration_average_ms Average completed request duration in milliseconds.",
      "# TYPE giro_request_duration_average_ms gauge",
      `giro_request_duration_average_ms ${finiteMetricValue(averageDurationMs)}`,
      "# HELP giro_request_duration_p50_ms Rolling p50 request duration in milliseconds.",
      "# TYPE giro_request_duration_p50_ms gauge",
      `giro_request_duration_p50_ms ${finiteMetricValue(this.requestDurationP50Ms)}`,
      "# HELP giro_request_duration_p95_ms Rolling p95 request duration in milliseconds.",
      "# TYPE giro_request_duration_p95_ms gauge",
      `giro_request_duration_p95_ms ${finiteMetricValue(this.requestDurationP95Ms)}`,
      "# HELP giro_request_duration_p99_ms Rolling p99 request duration in milliseconds.",
      "# TYPE giro_request_duration_p99_ms gauge",
      `giro_request_duration_p99_ms ${finiteMetricValue(this.requestDurationP99Ms)}`,
      "# HELP giro_process_uptime_seconds Backend process uptime in seconds.",
      "# TYPE giro_process_uptime_seconds gauge",
      `giro_process_uptime_seconds ${finiteMetricValue(Math.max(0, this.uptimeSeconds()))}`,
      "# HELP giro_process_start_time_seconds Backend process start time as Unix seconds.",
      "# TYPE giro_process_start_time_seconds gauge",
      `giro_process_start_time_seconds ${finiteMetricValue(this.processStartTimeSeconds)}`,
      "# HELP giro_process_memory_rss_bytes Resident memory used by the backend process.",
      "# TYPE giro_process_memory_rss_bytes gauge",
      `giro_process_memory_rss_bytes ${memory.rss}`,
      "# HELP giro_process_memory_heap_total_bytes Allocated JavaScript heap memory.",
      "# TYPE giro_process_memory_heap_total_bytes gauge",
      `giro_process_memory_heap_total_bytes ${memory.heapTotal}`,
      "# HELP giro_process_memory_heap_used_bytes Used JavaScript heap memory.",
      "# TYPE giro_process_memory_heap_used_bytes gauge",
      `giro_process_memory_heap_used_bytes ${memory.heapUsed}`,
      "# HELP giro_process_memory_external_bytes Memory used by external resources.",
      "# TYPE giro_process_memory_external_bytes gauge",
      `giro_process_memory_external_bytes ${memory.external}`,
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
      "# HELP giro_readiness_transitions_total Readiness state transitions.",
      "# TYPE giro_readiness_transitions_total counter",
      `giro_readiness_transitions_total ${this.readinessTransitions}`,
      "# HELP giro_worker_database_failures_total Worker database operation failures.",
      "# TYPE giro_worker_database_failures_total counter",
      `giro_worker_database_failures_total ${this.workerDatabaseFailures}`,
      "# HELP giro_worker_consecutive_database_failures Current consecutive worker database failures.",
      "# TYPE giro_worker_consecutive_database_failures gauge",
      `giro_worker_consecutive_database_failures ${this.workerConsecutiveDatabaseFailures}`,
      "# HELP giro_worker_last_successful_poll_timestamp_seconds Last successful worker database poll Unix timestamp.",
      "# TYPE giro_worker_last_successful_poll_timestamp_seconds gauge",
      `giro_worker_last_successful_poll_timestamp_seconds ${finiteMetricValue(this.workerLastSuccessfulPollSeconds)}`,
      "# HELP giro_worker_last_successful_claim_timestamp_seconds Last successful worker claim attempt Unix timestamp.",
      "# TYPE giro_worker_last_successful_claim_timestamp_seconds gauge",
      `giro_worker_last_successful_claim_timestamp_seconds ${finiteMetricValue(this.workerLastSuccessfulClaimSeconds)}`,
      "# HELP giro_worker_stalled Worker loop stalled state (1 stalled, 0 progressing).",
      "# TYPE giro_worker_stalled gauge",
      `giro_worker_stalled ${this.workerStalled}`,
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
      "# HELP giro_ranking_operations_total Weighted hybrid ranking operations.",
      "# TYPE giro_ranking_operations_total counter",
      `giro_ranking_operations_total ${this.rankingOperations}`,
      "# HELP giro_ranking_candidates_total Candidates processed by weighted ranking.",
      "# TYPE giro_ranking_candidates_total counter",
      `giro_ranking_candidates_total ${this.rankingCandidates}`,
      "# HELP giro_ranking_duration_ms Last weighted ranking duration in milliseconds.",
      "# TYPE giro_ranking_duration_ms gauge",
      `giro_ranking_duration_ms ${this.rankingDurationMs}`,
      "# HELP giro_retrieval_confidence_total Final retrieval confidence evaluations.",
      "# TYPE giro_retrieval_confidence_total counter",
      ...(["high", "medium", "low", "insufficient"] as const).map((level) =>
        `giro_retrieval_confidence_total{level="${level}"} ${this.retrievalConfidence.get(level) ?? 0}`
      ),
      "# HELP giro_retrieval_answerability_total Final retrieval answerability decisions.",
      "# TYPE giro_retrieval_answerability_total counter",
      ...(["true", "false"] as const).map((answerable) =>
        `giro_retrieval_answerability_total{answerable="${answerable}"} ${this.retrievalAnswerability.get(answerable) ?? 0}`
      ),
      "# HELP giro_retrieval_insufficient_evidence_total Fixed reasons for unanswerable retrieval evidence.",
      "# TYPE giro_retrieval_insufficient_evidence_total counter",
      ...[...this.retrievalInsufficientEvidence.entries()].map(([reason, value]) =>
        `giro_retrieval_insufficient_evidence_total{reason="${reason}"} ${value}`
      ),
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
      "# HELP giro_repository_graph_parsed_files_total TypeScript and JavaScript files parsed into durable graphs.",
      "# TYPE giro_repository_graph_parsed_files_total counter",
      `giro_repository_graph_parsed_files_total ${this.graphParsedFiles}`,
      "# HELP giro_repository_graph_parser_failures_total Files with parser diagnostics.",
      "# TYPE giro_repository_graph_parser_failures_total counter",
      `giro_repository_graph_parser_failures_total ${this.graphParserFailures}`,
      "# HELP giro_repository_graph_unresolved_imports_total Imports without a repository-local target.",
      "# TYPE giro_repository_graph_unresolved_imports_total counter",
      `giro_repository_graph_unresolved_imports_total ${this.graphUnresolvedImports}`,
      "# HELP giro_repository_graph_publication_failures_total Durable graph publication failures.",
      "# TYPE giro_repository_graph_publication_failures_total counter",
      `giro_repository_graph_publication_failures_total ${this.graphPublicationFailures}`,
      "# HELP giro_repository_graph_expansion_usage_total Retrievals that used graph expansion.",
      "# TYPE giro_repository_graph_expansion_usage_total counter",
      `giro_repository_graph_expansion_usage_total ${this.graphExpansionUsage}`,
      "# HELP giro_repository_graph_expanded_candidates_total Candidates introduced by graph traversal.",
      "# TYPE giro_repository_graph_expanded_candidates_total counter",
      `giro_repository_graph_expanded_candidates_total ${this.graphExpandedCandidates}`,
      "# HELP giro_repository_graph_retrieval_duration_ms Last graph traversal duration in milliseconds.",
      "# TYPE giro_repository_graph_retrieval_duration_ms gauge",
      `giro_repository_graph_retrieval_duration_ms ${this.graphRetrievalDurationMs}`,
      "# HELP giro_repository_summaries_total Repository architecture summaries generated.",
      "# TYPE giro_repository_summaries_total counter",
      `giro_repository_summaries_total ${this.repositorySummaries}`,
      "# HELP giro_repository_summary_generation_ms Last repository architecture summary generation duration in milliseconds.",
      "# TYPE giro_repository_summary_generation_ms gauge",
      `giro_repository_summary_generation_ms ${this.repositorySummaryGenerationMs}`,
      "# HELP giro_repository_summary_cache_hits_total Repository architecture summary cache hits.",
      "# TYPE giro_repository_summary_cache_hits_total counter",
      `giro_repository_summary_cache_hits_total ${this.repositorySummaryCacheHits}`,
      `giro_repository_intelligence_analysis_duration_ms_total ${this.intelligenceAnalysisDurationMs}`,
      `giro_repository_intelligence_generated_subsystems_total ${this.intelligenceGeneratedSubsystems}`,
      `giro_repository_intelligence_dependency_edges_total ${this.intelligenceDependencyEdges}`,
      `giro_repository_intelligence_quality_findings_total ${this.intelligenceQualityFindings}`,
      `giro_repository_intelligence_hotspots_total ${this.intelligenceHotspots}`,
      `giro_retrieval_intelligence_usage_total ${this.retrievalIntelligenceUsage}`,
      `giro_repository_intelligence_publication_failures_total ${this.intelligencePublicationFailures}`,
      `giro_repository_planning_duration_ms_total ${this.repositoryPlanningDurationMs}`,
      `giro_repository_planning_phases_total ${this.repositoryPlanningPhases}`,
      `giro_repository_planning_dependencies_total ${this.repositoryPlanningDependencies}`,
      `giro_repository_planning_risk_score_total ${this.repositoryPlanningRiskScore}`,
      `giro_repository_planner_failures_total ${this.repositoryPlannerFailures}`,
      `giro_repository_planning_retrieval_contribution_total ${this.repositoryPlanningRetrievalContribution}`,
      `giro_repository_execution_runs_created_total ${this.executionRunsCreated}`,
      `giro_repository_execution_approvals_total ${this.executionApprovals}`,
      `giro_repository_execution_active_runs ${this.executionActiveRuns}`,
      `giro_repository_execution_ready_units ${this.executionReadyUnits}`,
      `giro_repository_execution_blocked_units ${this.executionBlockedUnits}`,
      `giro_repository_execution_running_units ${this.executionRunningUnits}`,
      `giro_repository_execution_lease_recoveries_total ${this.executionLeaseRecoveries}`,
      `giro_repository_execution_retries_total ${this.executionRetries}`,
      `giro_repository_execution_failures_total ${this.executionFailures}`,
      `giro_repository_execution_review_latency_ms_total ${this.executionReviewLatencyMs}`,
      `giro_repository_execution_run_duration_ms_total ${this.executionRunDurationMs}`,
      `giro_repository_execution_critical_path_duration_ms_total ${this.executionCriticalPathDurationMs}`,
    );
    return `${lines.join("\n")}\n`;
  }
}

export const runtimeMetrics = new MetricsRegistry();
