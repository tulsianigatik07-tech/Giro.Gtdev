// Orchestrates repository dependency analysis. Read-only, deterministic.

import { existsSync } from "node:fs";
import { logger } from "../../lib/logger.js";
import { extractRepoSymbols } from "./symbolExtractor.js";
import {
  buildDependencyGraph,
  computeStats,
  detectInsights,
} from "./graphBuilder.js";
import type { DependencyGraph } from "./types.js";
import type { AuthorizedRepositoryContext } from "../repository/ownershipGuard.js";

export async function analyzeRepoDependencies(
  repository: AuthorizedRepositoryContext,
): Promise<DependencyGraph> {
  const clonePath = repository.checkoutPath;
  if (!existsSync(clonePath)) {
    throw new Error("Repository not connected");
  }

  const symbolMaps = await extractRepoSymbols(clonePath);
  const { nodes, edges } = buildDependencyGraph(symbolMaps);
  const stats = computeStats(nodes, edges);
  const insights = detectInsights(nodes, edges);

  logger.info("dependency_graph_complete", {
    repositoryId: repository.repositoryId,
    totalNodes: stats.totalNodes,
    totalEdges: stats.totalEdges,
  });

  return { nodes, edges, stats, insights };
}
