import { createHash } from "node:crypto";
import type {
  HybridRetrievalCandidate,
  HybridRetrievalDiagnostics,
  HybridRetrievalSignals,
  SourceCandidate,
  StructuralSignals,
} from "./types.js";
import { candidateKey } from "./types.js";

const EMPTY_STRUCTURAL: StructuralSignals = {
  repositoryDepth: 0,
  dependencyImportance: 0,
  exportedPublicSymbols: 0,
  referenceCount: 0,
  fileCentrality: 0,
  recentlyIndexedRevision: 0,
  generatedFilePenalty: 0,
  vendorDependencyPenalty: 0,
};

function emptySignals(): HybridRetrievalSignals {
  return {
    semanticSimilarity: 0,
    lexicalSimilarity: 0,
    symbolMatch: 0,
    pathSimilarity: 0,
    fileImportance: 0,
    repositoryImportance: 0,
    dependencyGraphImportance: 0,
    freshness: 0,
    revisionMatch: 0,
    graphRelationship: 0,
  };
}

function contentHash(content: string): string {
  return createHash("sha256").update(content.trim().replace(/\s+/gu, " ")).digest("hex");
}

function sourceScore(candidate: SourceCandidate): number {
  return Math.max(0, Math.min(1, candidate.result.score));
}

function publicSourcePriority(source: SourceCandidate["result"]["source"]): number {
  return { semantic: 0, keyword: 1, symbol: 2, graph: 3 }[source];
}

export function mergeRetrievalCandidates(
  candidates: readonly SourceCandidate[],
  expansionMultiplier: number,
  diagnostics: HybridRetrievalDiagnostics,
): HybridRetrievalCandidate[] {
  const merged = new Map<string, HybridRetrievalCandidate>();
  for (const input of candidates) {
    const key = input.result.chunkId ??
      `${input.result.repository}\u0000${input.result.filePath}\u0000${input.result.startLine}\u0000${input.result.endLine}`;
    const existing = merged.get(key);
    const candidate = existing ?? {
      result: { ...input.result },
      sources: new Set(),
      signals: emptySignals(),
      structural: { ...EMPTY_STRUCTURAL },
      expansionMultiplier: input.isExpanded ? expansionMultiplier : 1,
      baseScore: 0,
      rerankerScore: 0,
      finalScore: 0,
      originalRank: 0,
    };
    candidate.sources.add(input.source);
    const score = sourceScore(input);
    if (input.source === "semantic") candidate.signals.semanticSimilarity =
      Math.max(candidate.signals.semanticSimilarity, score);
    if (input.source === "lexical") candidate.signals.lexicalSimilarity =
      Math.max(candidate.signals.lexicalSimilarity, score);
    if (input.source === "symbol") candidate.signals.symbolMatch =
      Math.max(candidate.signals.symbolMatch, score);
    if (input.source === "path") candidate.signals.pathSimilarity =
      Math.max(candidate.signals.pathSimilarity, score);
    if (input.source === "graph") candidate.signals.graphRelationship =
      Math.max(candidate.signals.graphRelationship ?? 0, score);
    if (!input.isExpanded) candidate.expansionMultiplier = 1;
    if (
      score > candidate.result.score ||
      (score === candidate.result.score &&
        publicSourcePriority(input.result.source) <
          publicSourcePriority(candidate.result.source))
    ) {
      candidate.result = { ...input.result };
    }
    if (existing) {
      diagnostics.discardedCandidates.push({ key, reason: "duplicate_chunk" });
    } else {
      merged.set(key, candidate);
    }
  }

  const byContent = new Map<string, HybridRetrievalCandidate>();
  for (const candidate of [...merged.values()].sort((left, right) =>
    candidateKey(left).localeCompare(candidateKey(right)))) {
    const hash = contentHash(candidate.result.content);
    const existing = byContent.get(hash);
    if (!existing) {
      byContent.set(hash, candidate);
      continue;
    }
    for (const source of candidate.sources) existing.sources.add(source);
    for (const key of Object.keys(existing.signals) as Array<keyof HybridRetrievalSignals>) {
      existing.signals[key] = Math.max(
        existing.signals[key] ?? 0,
        candidate.signals[key] ?? 0,
      );
    }
    diagnostics.discardedCandidates.push({
      key: candidateKey(candidate),
      reason: "duplicate_content",
    });
  }
  return [...byContent.values()];
}
