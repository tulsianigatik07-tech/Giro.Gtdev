export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  status?: number;
  category?: string;
}

export type ApiResponse<T> =
  | { success: true; data: T; requestId: string }
  | { success: false; error: ApiErrorBody; requestId: string };

export type RepositoryIndexStatus = "indexing" | "indexed" | "failed" | "stale";

export interface IndexedRepository {
  owner: string;
  repo: string;
  status: RepositoryIndexStatus;
  indexedAt: string | null;
  lastAccessedAt: string | null;
  chunkCount: number;
  fileCount: number;
  symbolCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  summaryAvailable: boolean;
  firstIndexedAt: string | null;
  lastIndexedAt: string | null;
  totalIndexedFiles: number;
  lastIndexMode: "full" | "incremental" | null;
  lastChangedFileCount: number;
  lastFailureAt: string | null;
  failureReason: string | null;
  failedFileCount: number;
  retryCount: number;
  lastRetryAt: string | null;
}

export interface RepositoryDashboard {
  repository: string;
  status: {
    repository: string;
    health: { status: string; [key: string]: unknown };
    readiness: { status?: string; [key: string]: unknown };
  };
  metrics: {
    files: number;
    chunks: number;
    symbols: number;
    graphNodes: number;
    graphEdges: number;
  };
}

export interface RepositorySummaryItem {
  name: string;
  path?: string;
  kind?: string;
  reason?: string;
}

export interface RepositorySummary {
  repositoryId: string;
  repositoryVersion: string;
  generatedAt: string;
  purpose: string;
  languages?: RepositorySummaryItem[];
  frameworks?: RepositorySummaryItem[];
  packageManagers?: RepositorySummaryItem[];
  applications?: RepositorySummaryItem[];
  libraries?: RepositorySummaryItem[];
  services?: RepositorySummaryItem[];
  modules?: RepositorySummaryItem[];
  entrypoints?: RepositorySummaryItem[];
  importantDirectories?: RepositorySummaryItem[];
  configFiles?: RepositorySummaryItem[];
  apiSurface?: RepositorySummaryItem[];
  backgroundWorkers?: RepositorySummaryItem[];
  dataStores?: RepositorySummaryItem[];
  authentication?: RepositorySummaryItem[];
  retrieval?: RepositorySummaryItem[];
  indexing?: RepositorySummaryItem[];
  testing?: RepositorySummaryItem[];
  build?: RepositorySummaryItem[];
  deployment?: RepositorySummaryItem[];
  dependencyOverview?: {
    totalNodes: number;
    totalEdges: number;
    centralModules: string[];
    dependencyHotspots: string[];
    circularDependencies: string[][];
  };
}

export interface ConnectRepositoryResult {
  repositoryId: string;
  jobId?: string;
  status: "queued" | "already_indexed";
}

export type IndexingJobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface IndexingJob {
  jobId: string;
  repositoryId: string;
  status: IndexingJobStatus;
  progress: number;
  currentStage: string;
  attempt: number;
  maxAttempts: number;
  failure: { code: string; message: string; retryable: boolean } | null;
}

export type IndexingStage =
  | "queued"
  | "cloning"
  | "parsing"
  | "chunking"
  | "embedding"
  | "uploading_vectors"
  | "finalizing"
  | "completed"
  | "failed";

export interface IndexingProgress {
  jobId: string;
  repositoryId: string;
  stage: IndexingStage;
  percentage: number;
  message: string;
  timestamp: string;
}

export interface GroundedCitation {
  repositoryId: string;
  relativeFilePath: string;
  language: string;
  chunkId: string;
  startLine: number;
  endLine: number;
  retrievalType: "semantic" | "keyword" | "symbol" | "graph" | "hybrid" | "file-search";
  score: number;
  symbol?: string;
  repositoryVersion: string;
}

export interface LegacyCitation {
  filePath: string;
  startLine: number;
  endLine: number;
  snippet?: string;
}

export type Citation = GroundedCitation | LegacyCitation;

export interface SelectedContextChunk {
  filePath: string;
  language: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
  source?: string;
  signals?: RetrievalSignals;
  chunkId?: string;
  symbol?: string;
  repositoryVersion?: string;
  citationRetrievalType?: string;
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  createdAt: string;
}

export interface Session {
  id: string;
  userId: string;
  owner: string;
  repo: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
  selectedContext: SelectedContextChunk[];
}

export interface SessionSummary {
  id: string;
  userId: string;
  owner: string;
  repo: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export type ConfidenceLevel = "high" | "medium" | "low" | "insufficient";

export interface RetrievalConfidence {
  level: ConfidenceLevel;
  score: number;
  answerable: boolean;
  reasons: string[];
}

export interface AskResult {
  answer: string;
  sources: Array<{ path: string; reason: string; score: number }>;
  citations: GroundedCitation[];
  metadata: {
    retrievedFiles: number;
    usedSummary: boolean;
    usedDependencyGraph: boolean;
    retrievalSourceCounts: Record<"semantic" | "keyword" | "symbol" | "graph" | "fileSearch", number>;
    estimatedContextTokens: number;
    confidence?: RetrievalConfidence;
  };
}

export interface RetrievalSignals {
  semantic?: number;
  keyword?: number;
  symbol?: number;
  graph?: number;
}

export interface RetrievalResult {
  repository: string;
  filePath: string;
  language: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
  source: "semantic" | "keyword" | "symbol" | "graph";
  signals: RetrievalSignals;
  chunkId?: string;
  symbol?: string;
}

export interface HybridRetrievalResult {
  query: string;
  repository: string;
  results: RetrievalResult[];
  citations?: GroundedCitation[];
  stats: {
    semanticResults: number;
    keywordResults: number;
    symbolResults: number;
    graphBoosted: number;
    returned: number;
  };
}

export function isGroundedCitation(citation: Citation): citation is GroundedCitation {
  return "relativeFilePath" in citation;
}
