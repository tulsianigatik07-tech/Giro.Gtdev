import type { PublishedRepositoryArtifacts } from "../../repository/artifacts/repositoryArtifactStore.js";
import type { HybridRetrievalCandidate } from "./types.js";
import type { RepositoryIntelligenceRecord } from "../../repositoryIntelligence/types.js";

const GENERATED = /(^|\/)(dist|build|coverage|generated|__generated__)(\/|$)|(?:\.generated\.|\.min\.)/iu;
const VENDOR = /(^|\/)(node_modules|vendor|third_party|deps)(\/|$)/iu;

function normalize(value: number, maximum: number): number {
  return maximum > 0 ? Math.min(1, value / maximum) : 0;
}

function importantPaths(artifacts: PublishedRepositoryArtifacts): Set<string> {
  const summary = artifacts.summary;
  return new Set([
    ...summary.entrypoints,
    ...summary.modules,
    ...summary.services,
    ...summary.apiSurface,
    ...summary.retrieval,
    ...summary.indexing,
  ].flatMap((item) => item.path ? [item.path] : []));
}

export function computeStructuralSignals(
  candidates: readonly HybridRetrievalCandidate[],
  artifacts: PublishedRepositoryArtifacts | null,
  repositoryRevision: string,
  intelligence: RepositoryIntelligenceRecord | null = null,
): HybridRetrievalCandidate[] {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  const exported = new Map<string, number>();
  const references = new Map<string, number>();
  const latest = artifacts?.fileSnapshot.files.reduce(
    (maximum, file) => Math.max(maximum, Date.parse(file.lastSeenAt) || 0),
    0,
  ) ?? 0;
  const freshness = new Map(artifacts?.fileSnapshot.files.map((file) => [
    file.filePath,
    latest > 0 && (Date.parse(file.lastSeenAt) || 0) === latest ? 1 : 0,
  ]) ?? []);
  const symbolFile = new Map(artifacts?.graph.nodes.map((node) => [node.symbolId, node.file]) ?? []);
  for (const file of artifacts?.graphSource ?? []) {
    exported.set(file.filePath, file.symbols.filter((symbol) => symbol.exported).length);
    outgoing.set(file.filePath, file.imports.length);
    for (const imported of file.imports) {
      incoming.set(imported.source, (incoming.get(imported.source) ?? 0) + 1);
    }
  }
  for (const edge of artifacts?.graph.edges ?? []) {
    const source = symbolFile.get(edge.fromSymbolId);
    const target = symbolFile.get(edge.toSymbolId);
    if (source) outgoing.set(source, (outgoing.get(source) ?? 0) + 1);
    if (target) {
      incoming.set(target, (incoming.get(target) ?? 0) + 1);
      references.set(target, (references.get(target) ?? 0) + 1);
    }
  }
  const maxIncoming = Math.max(0, ...incoming.values());
  const maxExported = Math.max(0, ...exported.values());
  const maxReferences = Math.max(0, ...references.values());
  const graphFiles = new Set([...incoming.keys(), ...outgoing.keys()]);
  const maximumDegree = [...graphFiles].reduce((max, file) =>
    Math.max(max, (incoming.get(file) ?? 0) + (outgoing.get(file) ?? 0)), 0);
  const important = artifacts ? importantPaths(artifacts) : new Set<string>();
  const central = new Set(artifacts?.summary.dependencyOverview.centralModules ?? []);
  const intelligenceHints = intelligence?.repositoryRevision === repositoryRevision
    ? new Set([
        ...intelligence.symbols.entrypoints,
        ...intelligence.architecture.hotspots.map((item) => item.path),
        ...intelligence.codeOrganization.mostImportedFiles.map((item) => item.path),
        ...intelligence.symbols.publicApis.map((item) => item.file),
      ])
    : new Set<string>();

  return candidates.map((candidate) => {
    const path = candidate.result.filePath;
    const generatedPenalty = GENERATED.test(path) ? 1 : 0;
    const vendorPenalty = VENDOR.test(path) ? 1 : 0;
    const dependencyImportance = normalize(incoming.get(path) ?? 0, maxIncoming);
    const exportedPublicSymbols = normalize(exported.get(path) ?? 0, maxExported);
    const referenceCount = normalize(references.get(path) ?? 0, maxReferences);
    const fileCentrality = normalize(
      (incoming.get(path) ?? 0) + (outgoing.get(path) ?? 0),
      maximumDegree,
    );
    candidate.structural = {
      repositoryDepth: 1 / (1 + path.split("/").length - 1),
      dependencyImportance,
      exportedPublicSymbols,
      referenceCount,
      fileCentrality,
      recentlyIndexedRevision: freshness.get(path) ?? 0,
      generatedFilePenalty: generatedPenalty,
      vendorDependencyPenalty: vendorPenalty,
    };
    candidate.signals.fileImportance =
      (candidate.structural.repositoryDepth + exportedPublicSymbols + referenceCount + fileCentrality) / 4;
    candidate.signals.repositoryImportance =
      important.has(path) || central.has(path) || intelligenceHints.has(path) ? 1 : 0;
    candidate.signals.dependencyGraphImportance = dependencyImportance;
    candidate.signals.freshness = candidate.structural.recentlyIndexedRevision;
    candidate.signals.revisionMatch =
      artifacts?.repositoryRevision === repositoryRevision ? 1 : 0;
    const penalty = (1 - generatedPenalty * 0.35) * (1 - vendorPenalty * 0.65);
    candidate.expansionMultiplier *= penalty;
    return candidate;
  });
}
