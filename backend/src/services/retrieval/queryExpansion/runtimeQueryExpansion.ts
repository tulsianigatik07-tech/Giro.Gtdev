import { env } from "../../../config/env.js";
import { logger } from "../../../lib/logger.js";
import { runtimeMetrics } from "../../../observability/metrics.js";
import { getFileSymbolMaps } from "../../repository/graphSourceStore.js";
import { getRepositorySymbols } from "../../repository/symbolIndexStore.js";
import { getRepositorySymbolGraph } from "../../repositoryGraph/runtimeRepositoryGraph.js";
import { getRepositorySummary } from "../../repositorySummary/runtimeRepositorySummary.js";
import { QueryExpansionService } from "./queryExpansion.js";
import type {
  QueryExpansionMetadata,
  QueryExpansionResult,
} from "./queryExpansionTypes.js";

const runtimeQueryExpansionService = new QueryExpansionService({
  metrics: runtimeMetrics,
  logger,
  maxCacheEntries: env.RETRIEVAL_CACHE_MAX_ENTRIES,
});

function itemNames(items: readonly { name: string }[] | undefined): string[] {
  return items?.map((item) => item.name) ?? [];
}

function graphNodeTerm(name: string, kind: string): string {
  if (kind !== "module") return name;
  const normalized = name.replace(/\\/g, "/");
  return (normalized.split("/").at(-1) ?? normalized).replace(/\.[^.]+$/, "");
}

function matchesRetrievalVersion(
  metadataVersion: string,
  retrievalVersion: string,
): boolean {
  return metadataVersion === retrievalVersion ||
    retrievalVersion.startsWith(`${metadataVersion}:`) ||
    (metadataVersion === "unversioned" && retrievalVersion === "unversioned");
}

export function getRuntimeQueryExpansionMetadata(
  repositoryId: string,
  repositoryVersion: string,
): QueryExpansionMetadata {
  const storedSummary = getRepositorySummary(repositoryId);
  const summary = storedSummary &&
      matchesRetrievalVersion(storedSummary.repositoryVersion, repositoryVersion)
    ? storedSummary
    : null;
  const symbolGraph = getRepositorySymbolGraph(repositoryId);
  const currentGraph = symbolGraph &&
      matchesRetrievalVersion(symbolGraph.repositoryVersion, repositoryVersion)
    ? symbolGraph
    : null;
  const hasCurrentMetadata = Boolean(summary || currentGraph) || repositoryVersion === "unversioned";
  const fileMaps = hasCurrentMetadata ? getFileSymbolMaps(repositoryId) : [];
  const symbolRecords = hasCurrentMetadata ? getRepositorySymbols(repositoryId) : [];
  const exportedByLocation = new Set(
    fileMaps.flatMap((map) => map.symbols
      .filter((symbol) => symbol.exported)
      .map((symbol) => `${map.filePath}\u0000${symbol.name}`)),
  );
  const packages = fileMaps.flatMap((map) => map.imports
    .filter((entry) => !entry.isRelative)
    .map((entry) => entry.source));
  const graphNodeById = new Map(
    currentGraph?.nodes.map((node) => [node.symbolId, node]) ?? [],
  );

  return {
    frameworks: itemNames(summary?.frameworks),
    modules: [
      ...itemNames(summary?.modules),
      ...itemNames(summary?.applications),
      ...itemNames(summary?.libraries),
      ...(summary?.dependencyOverview.centralModules ?? []),
      ...(summary?.dependencyOverview.dependencyHotspots ?? []),
      ...(summary?.dependencyOverview.isolatedModules ?? []),
    ],
    services: itemNames(summary?.services),
    apiRoutes: itemNames(summary?.apiSurface),
    packages: [...new Set(packages)].sort((a, b) => a.localeCompare(b)),
    filenames: [...new Set([
      ...fileMaps.map((map) => map.filePath),
      ...symbolRecords.map((symbol) => symbol.filePath),
      ...itemNames(summary?.configFiles),
      ...itemNames(summary?.entrypoints),
    ])].sort((a, b) => a.localeCompare(b)),
    symbols: symbolRecords.map((symbol) => ({
      name: symbol.symbolName,
      filePath: symbol.filePath,
      exported: exportedByLocation.has(`${symbol.filePath}\u0000${symbol.symbolName}`),
    })),
    imports: fileMaps.flatMap((map) => map.imports.map((entry) => ({
      fromFile: map.filePath,
      source: entry.source,
      importedSymbols: [...entry.specifiers],
      isRelative: entry.isRelative,
    }))),
    graphRelations: currentGraph
      ? currentGraph.edges.flatMap((edge) => {
          const from = graphNodeById.get(edge.fromSymbolId);
          const to = graphNodeById.get(edge.toSymbolId);
          return from && to
            ? [{
                from: graphNodeTerm(from.name, from.kind),
                to: graphNodeTerm(to.name, to.kind),
                kind: edge.kind,
              }]
            : [];
        })
      : [],
  };
}

export function expandRuntimeQuery(input: {
  repositoryId: string;
  repositoryVersion: string;
  query: string;
}): QueryExpansionResult {
  return runtimeQueryExpansionService.expand({
    ...input,
    metadata: getRuntimeQueryExpansionMetadata(input.repositoryId, input.repositoryVersion),
    maxTerms: env.QUERY_EXPANSION_MAX_TERMS,
    expandedScoreMultiplier: env.QUERY_EXPANSION_SCORE_PENALTY,
  });
}

export function clearRuntimeQueryExpansionCache(): void {
  runtimeQueryExpansionService.clear();
}
