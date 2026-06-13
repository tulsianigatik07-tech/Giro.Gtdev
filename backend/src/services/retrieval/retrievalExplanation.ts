// Deterministic, pure utility that explains WHY a file was retrieved, as
// human-readable reason strings. Distinct from explainability.ts /
// retrievalTrace.ts (which emit structured per-chunk reason objects).
//
// Determinism: no I/O, no timestamps, no randomness, no module-level mutable
// state. Inputs are never mutated. Ordering within each category uses default
// lexicographic Array.prototype.sort() (UTF-16 code-unit order) so results are
// invariant across locales/environments. Identical input -> deepEqual output.

export interface RetrievalExplanation {
  filePath: string;
  reasons: string[];
}

export interface RetrievalExplanationInput {
  filePath: string;
  matchedSymbols?: string[];
  matchedKeywords?: string[];
  graphConnections?: string[];
}

// Copy -> de-duplicate -> lexicographic sort -> join. Never touches the input.
function normalizeJoin(values: string[] | undefined): string {
  return [...new Set(values ?? [])].sort().join(", ");
}

export function buildRetrievalExplanation(
  options: RetrievalExplanationInput,
): RetrievalExplanation {
  const reasons: string[] = [];

  const symbols = options.matchedSymbols ?? [];
  if (symbols.length > 0) {
    reasons.push("Matched symbols: " + normalizeJoin(symbols));
  }

  const keywords = options.matchedKeywords ?? [];
  if (keywords.length > 0) {
    reasons.push("Matched keywords: " + normalizeJoin(keywords));
  }

  const connections = options.graphConnections ?? [];
  if (connections.length > 0) {
    reasons.push("Connected files: " + normalizeJoin(connections));
  }

  return { filePath: options.filePath, reasons };
}
