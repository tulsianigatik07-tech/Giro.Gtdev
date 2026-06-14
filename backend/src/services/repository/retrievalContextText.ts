// Pure, deterministic formatter rendering a RetrievalContextSummary into a
// compact 8-line retrieval-ready string. NOT AI — formatting only. No I/O,
// timestamps, randomness, or module state; never mutates the input. Identical
// input -> identical string.
//
// Keywords are rendered exactly via join(", ") with no sort/filter/dedup. For
// an empty keyword array the line is exactly "- Keywords: " (the single space
// after the colon is part of the fixed label).

import type { RetrievalContextSummary } from "./retrievalContextSummary.js";

export function buildRetrievalContextText(summary: RetrievalContextSummary): string {
  return [
    "Repository retrieval context:",
    `- Scale: ${summary.repositoryScale}`,
    `- Architecture complexity: ${summary.architectureComplexity}`,
    `- Health category: ${summary.healthCategory}`,
    `- Files: ${summary.totalFiles}`,
    `- Symbols: ${summary.totalSymbols}`,
    `- Dependencies: ${summary.totalDependencies}`,
    `- Keywords: ${summary.retrievalKeywords.join(", ")}`,
  ].join("\n");
}
