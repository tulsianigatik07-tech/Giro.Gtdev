// Pure, deterministic text formatter that renders a RepositoryOverview into a
// stable 12-line string for future UI cards / retrieval context / answer
// preambles. NOT AI — formatting only. No I/O, timestamps, randomness, or
// module state; never mutates the input. Identical input -> identical string.
//
// Notes:
// - "Files" intentionally uses structure.totalFiles (architecture also has a
//   totalFiles; the structure count is the source of truth for this line).
// - averageDependenciesPerFile is already Number(...toFixed(2)); rendered as-is
//   via interpolation (2 -> "2", 2.5 -> "2.5", 0.33 -> "0.33"). No re-rounding.

import type { RepositoryOverview } from "./repositoryOverview.js";

export function buildRepositoryOverviewText(overview: RepositoryOverview): string {
  const { structure, architecture } = overview;
  return [
    "Repository overview:",
    `- Files: ${structure.totalFiles}`,
    `- Chunks: ${structure.totalChunks}`,
    `- Symbols: ${structure.totalSymbols}`,
    `- Graph nodes: ${structure.totalGraphNodes}`,
    `- Graph edges: ${structure.totalGraphEdges}`,
    `- Scale: ${structure.repositoryScale}`,
    `- Dependencies: ${architecture.totalDependencies}`,
    `- Average dependencies per file: ${architecture.averageDependenciesPerFile}`,
    `- Connected files: ${architecture.connectedFiles}`,
    `- Isolated files: ${architecture.isolatedFiles}`,
    `- Architecture complexity: ${architecture.architectureComplexity}`,
  ].join("\n");
}
