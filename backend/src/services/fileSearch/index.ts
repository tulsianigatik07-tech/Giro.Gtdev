// File-level semantic search orchestrator. Deterministic + read-only.

import { existsSync } from "node:fs";
import { logger } from "../../lib/logger.js";
import { extractRepoSymbols } from "../graph/symbolExtractor.js";
import { analyzeRepoDependencies } from "../graph/index.js";
import { tokenize } from "./tokenizer.js";
import { scoreFile } from "./scorer.js";
import { explain } from "./explainer.js";
import type {
  FileSearchRequest,
  FileSearchResponse,
  FileSearchResult,
} from "./types.js";
import type { AuthorizedRepositoryContext } from "../repository/ownershipGuard.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export async function searchRepositoryFiles(
  request: FileSearchRequest,
  authorizedRepository: AuthorizedRepositoryContext,
): Promise<FileSearchResponse> {
  const { query } = request;
  const repository = authorizedRepository.repositoryId;
  const limit = Math.min(MAX_LIMIT, Math.max(1, request.limit ?? DEFAULT_LIMIT));
  const clonePath = authorizedRepository.checkoutPath;

  if (!existsSync(clonePath)) {
    throw new Error("Repository not connected");
  }

  const symbolMaps = await extractRepoSymbols(clonePath);

  // Centrality is a soft signal; degrade gracefully if the graph fails.
  let centrality = new Map<string, number>();
  try {
    const graph = await analyzeRepoDependencies(authorizedRepository);
    centrality = new Map(graph.nodes.map((n) => [n.filePath, n.centralityScore]));
  } catch (err) {
    logger.warn("file_search_graph_unavailable", {
      repository,
      message: err instanceof Error ? err.message : "unknown",
    });
  }

  const queryTokens = tokenize(query);

  const scored: FileSearchResult[] = symbolMaps.map((file) => {
    const { signals, score } = scoreFile(
      queryTokens,
      file,
      centrality.get(file.filePath) ?? 0,
    );
    return {
      path: file.filePath,
      score,
      reason: explain(signals),
      symbols: file.symbols.filter((s) => s.exported).map((s) => s.name),
      language: file.language,
    };
  });

  const results = scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);

  logger.info("file_search_complete", {
    repository,
    totalFilesScanned: symbolMaps.length,
    returned: results.length,
  });

  return {
    query,
    repository,
    results,
    totalFilesScanned: symbolMaps.length,
  };
}
