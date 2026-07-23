import type { PublishedRepositoryArtifacts } from "../../repository/artifacts/repositoryArtifactStore.js";
import type { RetrievalResult } from "../types.js";

import type {
  RepositoryGraphTraversalWeights,
} from "../../repositoryGraph/graphTraversal.js";
import type { RepositorySymbolGraph } from "../../repositoryGraph/graphTypes.js";

export type HybridRetrievalSource = "lexical" | "semantic" | "symbol" | "path" | "graph";

export interface HybridRetrievalSignals {
  semanticSimilarity: number;
  lexicalSimilarity: number;
  symbolMatch: number;
  pathSimilarity: number;
  fileImportance: number;
  repositoryImportance: number;
  dependencyGraphImportance: number;
  freshness: number;
  revisionMatch: number;
  graphRelationship?: number;
}

export interface StructuralSignals {
  repositoryDepth: number;
  dependencyImportance: number;
  exportedPublicSymbols: number;
  referenceCount: number;
  fileCentrality: number;
  recentlyIndexedRevision: number;
  generatedFilePenalty: number;
  vendorDependencyPenalty: number;
}

export interface HybridRetrievalCandidate {
  result: RetrievalResult;
  sources: Set<HybridRetrievalSource>;
  signals: HybridRetrievalSignals;
  structural: StructuralSignals;
  expansionMultiplier: number;
  baseScore: number;
  rerankerScore: number;
  finalScore: number;
  originalRank: number;
}

export interface SourceCandidate {
  source: HybridRetrievalSource;
  result: RetrievalResult;
  isExpanded?: boolean;
  graphDistance?: number;
  graphEdgeKind?: string;
}

export interface DiscardedCandidate {
  key: string;
  reason:
    | "duplicate_chunk"
    | "duplicate_content"
    | "same_file_limit"
    | "repeated_symbol"
    | "chunk_limit"
    | "file_limit"
    | "symbol_limit"
    | "token_budget";
}

export interface HybridRetrievalDiagnostics {
  candidateCounts: Record<HybridRetrievalSource | "merged" | "reranked" | "returned", number>;
  candidates: Array<{
    key: string;
    retrievalSources: HybridRetrievalSource[];
    lexicalScore: number;
    semanticScore: number;
    rerankerScore: number;
  }>;
  diversityDecisions: Array<{ key: string; decision: "selected" | "discarded"; reason?: string }>;
  discardedCandidates: DiscardedCandidate[];
  tokenUsage: { used: number; maximum: number };
  graph: {
    used: boolean;
    graphVersion: string | null;
    expandedCandidates: number;
    traversalDepth: number;
    durationMs: number;
    weights: RepositoryGraphTraversalWeights;
  };
}

export interface HybridRetrievalWeights {
  semanticSimilarity: number;
  lexicalSimilarity: number;
  symbolMatch: number;
  pathSimilarity: number;
  fileImportance: number;
  repositoryImportance: number;
  dependencyGraphImportance: number;
  freshness: number;
  revisionMatch: number;
  graphRelationship?: number;
}

export interface HybridRetrievalV2Config {
  weights: HybridRetrievalWeights;
  maxChunks: number;
  maxFiles: number;
  maxSymbols: number;
  maxTokens: number;
  maxPerFile: number;
  rerankerWeight: number;
  rerankerProvider: "deterministic" | "openai";
  rerankerModel: string;
  graphTraversal?: {
    enabled: boolean;
    maxDepth: number;
    maxCandidates: number;
    weights: RepositoryGraphTraversalWeights;
  };
}

export interface HybridRetrievalPipelineInput {
  query: string;
  repositoryId: string;
  repositoryRevision: string;
  candidates: readonly SourceCandidate[];
  artifacts: PublishedRepositoryArtifacts | null;
  limit: number;
  expansionMultiplier?: number;
  graph?: RepositorySymbolGraph | null;
}

export function candidateKey(candidate: Pick<HybridRetrievalCandidate, "result">): string {
  const result = candidate.result;
  return result.chunkId ??
    `${result.repository}\u0000${result.filePath}\u0000${result.startLine}\u0000${result.endLine}`;
}
