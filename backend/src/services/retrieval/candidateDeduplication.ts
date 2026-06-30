import type { RetrievalCandidate } from "./candidateFilter.js";

function candidateKey(candidate: RetrievalCandidate): string {
  return `${candidate.filePath}::${candidate.content}`;
}

export function dedupeRetrievalCandidates(
  candidates: readonly RetrievalCandidate[],
): RetrievalCandidate[] {
  const bestByKey = new Map<string, RetrievalCandidate>();

  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const existing = bestByKey.get(key);

    if (!existing || candidate.score > existing.score) {
      bestByKey.set(key, { ...candidate });
    }
  }

  return [...bestByKey.values()].sort(
    (a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath),
  );
}