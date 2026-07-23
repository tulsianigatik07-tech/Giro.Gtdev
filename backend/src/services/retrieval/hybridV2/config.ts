import { env } from "../../../config/env.js";
import type { HybridRetrievalV2Config, HybridRetrievalWeights } from "./types.js";

export function normalizeRetrievalWeights(
  weights: HybridRetrievalWeights,
): HybridRetrievalWeights {
  const entries = Object.entries(weights) as Array<[keyof HybridRetrievalWeights, number]>;
  if (entries.some(([, value]) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Retrieval weights must be finite and non-negative.");
  }
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) throw new Error("At least one retrieval weight must be positive.");
  return Object.freeze(Object.fromEntries(
    entries.map(([key, value]) => [key, value / total]),
  ) as unknown as HybridRetrievalWeights);
}

export function validateHybridRetrievalV2Config(
  config: HybridRetrievalV2Config,
): void {
  const normalized = normalizeRetrievalWeights(config.weights);
  const total = Object.values(normalized).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error("Retrieval weights do not normalize to one.");
  for (const [name, value] of Object.entries({
    maxChunks: config.maxChunks,
    maxFiles: config.maxFiles,
    maxSymbols: config.maxSymbols,
    maxTokens: config.maxTokens,
    maxPerFile: config.maxPerFile,
    graphMaxDepth: config.graphTraversal?.maxDepth ?? 1,
    graphMaxCandidates: config.graphTraversal?.maxCandidates ?? 1,
  })) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Retrieval ${name} must be a positive integer.`);
    }
  }
  if (!Number.isFinite(config.rerankerWeight) ||
      config.rerankerWeight < 0 ||
      config.rerankerWeight > 1) {
    throw new Error("Reranker weight must be between zero and one.");
  }
  if (!config.rerankerModel.trim()) throw new Error("Reranker model is required.");
  const graphWeights = Object.values(config.graphTraversal?.weights ?? {});
  if (graphWeights.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("Graph retrieval weights must be finite and between zero and one.");
  }
}

export const runtimeHybridRetrievalV2Config: HybridRetrievalV2Config = Object.freeze({
  weights: normalizeRetrievalWeights({
    semanticSimilarity: env.RETRIEVAL_V2_SEMANTIC_WEIGHT,
    lexicalSimilarity: env.RETRIEVAL_V2_LEXICAL_WEIGHT,
    symbolMatch: env.RETRIEVAL_V2_SYMBOL_WEIGHT,
    pathSimilarity: env.RETRIEVAL_V2_PATH_WEIGHT,
    fileImportance: env.RETRIEVAL_V2_FILE_IMPORTANCE_WEIGHT,
    repositoryImportance: env.RETRIEVAL_V2_REPOSITORY_IMPORTANCE_WEIGHT,
    dependencyGraphImportance: env.RETRIEVAL_V2_DEPENDENCY_IMPORTANCE_WEIGHT,
    freshness: env.RETRIEVAL_V2_FRESHNESS_WEIGHT,
    revisionMatch: env.RETRIEVAL_V2_REVISION_MATCH_WEIGHT,
    graphRelationship: 0.10,
  }),
  maxChunks: env.RETRIEVAL_V2_MAX_CHUNKS,
  maxFiles: env.RETRIEVAL_V2_MAX_FILES,
  maxSymbols: env.RETRIEVAL_V2_MAX_SYMBOLS,
  maxTokens: env.RETRIEVAL_V2_MAX_TOKENS,
  maxPerFile: env.RETRIEVAL_V2_MAX_PER_FILE,
  rerankerWeight: env.RETRIEVAL_RERANKER_WEIGHT,
  rerankerProvider: env.RETRIEVAL_RERANKER_PROVIDER,
  rerankerModel: env.RETRIEVAL_RERANKER_MODEL,
  graphTraversal: {
    enabled: true,
    maxDepth: env.REPOSITORY_GRAPH_TRAVERSAL_DEPTH,
    maxCandidates: env.REPOSITORY_GRAPH_MAX_EXPANDED_CANDIDATES,
    weights: {
      directRelationship: env.RETRIEVAL_GRAPH_DIRECT_WEIGHT,
      callEdge: env.RETRIEVAL_GRAPH_CALL_WEIGHT,
      importEdge: env.RETRIEVAL_GRAPH_IMPORT_WEIGHT,
      inheritance: env.RETRIEVAL_GRAPH_INHERITANCE_WEIGHT,
      implementation: env.RETRIEVAL_GRAPH_IMPLEMENTATION_WEIGHT,
      referenceCount: env.RETRIEVAL_GRAPH_REFERENCE_WEIGHT,
      centrality: env.RETRIEVAL_GRAPH_CENTRALITY_WEIGHT,
      distancePenalty: env.RETRIEVAL_GRAPH_DISTANCE_PENALTY,
    },
  },
});

validateHybridRetrievalV2Config(runtimeHybridRetrievalV2Config);
