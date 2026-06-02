// Builds a human-readable, deterministic explanation from scoring signals.

import type { ScoringSignals } from "./types.js";

export function explain(signals: ScoringSignals): string {
  const reasons: Array<{ weight: number; text: string }> = [];

  if (signals.filenameMatch > 0) {
    reasons.push({ weight: signals.filenameMatch, text: "filename matches query" });
  }
  if (signals.symbolMatch > 0) {
    reasons.push({ weight: signals.symbolMatch, text: "exported symbols match query" });
  }
  if (signals.keywordOverlap > 0) {
    reasons.push({ weight: signals.keywordOverlap, text: "keyword overlap in file" });
  }
  if (signals.directoryImportance >= 0.8) {
    reasons.push({
      weight: signals.directoryImportance,
      text: "located in an architecturally important directory",
    });
  }
  if (signals.centralityBoost >= 0.5) {
    reasons.push({
      weight: signals.centralityBoost,
      text: "highly connected module in the dependency graph",
    });
  }

  if (reasons.length === 0) {
    return "Weak match: only loosely related to the query.";
  }

  // Deterministic ordering: strongest signal first, then alphabetical.
  reasons.sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text));

  const top = reasons.slice(0, 3).map((r) => r.text);
  return top.join("; ") + ".";
}
