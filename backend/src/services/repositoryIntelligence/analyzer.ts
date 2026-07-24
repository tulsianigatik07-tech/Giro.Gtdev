import type {
  RepositoryIntelligenceBuildInput,
  RepositoryIntelligenceSnapshot,
  RepositorySubsystemSummary,
} from "./types.js";
import {
  REPOSITORY_INTELLIGENCE_ANALYSIS_VERSION,
  REPOSITORY_INTELLIGENCE_SCHEMA_VERSION,
} from "./types.js";
import { deterministicIntelligenceVersion } from "./version.js";

const FILE_NODE_KINDS = new Set(["file", "module"]);
const GENERATED = /(^|\/)(dist|build|coverage|generated|__generated__)(\/|$)|(?:\.generated\.|\.min\.)/u;
const ENTRYPOINT = /(^|\/)(index|main|app|server|cli|mod)\.[cm]?[jt]sx?$/u;
const UTILITY = /(^|\/)(util|utils|common|shared|helpers)(\/|\.|$)/u;
const DOC = /(^|\/)(readme|docs?|documentation)(\/|\.|$)|\.md$/iu;

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function rank(values: ReadonlyMap<string, number>, limit = 25) {
  return [...values].map(([path, value]) => ({ path, value }))
    .sort((a, b) => b.value - a.value || a.path.localeCompare(b.path))
    .slice(0, limit);
}

function subsystemRoot(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return ".";
  if (["src", "lib", "app", "apps", "packages", "services"].includes(parts[0] ?? "")) {
    return parts.slice(0, Math.min(parts.length - 1, 2)).join("/");
  }
  return parts[0] ?? ".";
}

function subsystemId(root: string): string {
  return `subsystem:${root.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "root"}`;
}

function layerFor(path: string): string {
  if (/(^|\/)(routes?|controllers?|api|http)(\/|$)/u.test(path)) return "interface";
  if (/(^|\/)(services?|use-?cases?|application)(\/|$)/u.test(path)) return "application";
  if (/(^|\/)(domain|models?|entities)(\/|$)/u.test(path)) return "domain";
  if (/(^|\/)(db|database|storage|persistence|infra)(\/|$)/u.test(path)) return "infrastructure";
  if (/(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./u.test(path)) return "test";
  return "unclassified";
}

function findCycles(adjacency: ReadonlyMap<string, readonly string[]>): string[][] {
  const cycles = new Map<string, string[]>();
  const visit = (start: string, node: string, path: string[], seen: Set<string>) => {
    for (const next of adjacency.get(node) ?? []) {
      if (next === start && path.length > 1) {
        const cycle = [...path];
        const rotations = cycle.map((_, index) => [...cycle.slice(index), ...cycle.slice(0, index)]);
        const canonical = rotations.sort((a, b) => a.join("\0").localeCompare(b.join("\0")))[0]!;
        cycles.set(canonical.join("\0"), canonical);
      } else if (!seen.has(next) && path.length < adjacency.size) {
        visit(start, next, [...path, next], new Set([...seen, next]));
      }
    }
  };
  for (const start of [...adjacency.keys()].sort()) visit(start, start, [start], new Set([start]));
  return [...cycles.values()].sort((a, b) => a.join("\0").localeCompare(b.join("\0")));
}

function fileForNodeId(input: RepositoryIntelligenceBuildInput): Map<string, string> {
  const nodeById = new Map(input.nodes.map((node) => [node.nodeId, node]));
  const result = new Map<string, string>();
  for (const node of input.nodes) if (node.file) result.set(node.nodeId, node.file);
  for (const edge of input.edges) {
    if (edge.kind !== "contains") continue;
    const parent = nodeById.get(edge.fromNodeId);
    if (parent?.file) result.set(edge.toNodeId, parent.file);
  }
  return result;
}

export function analyzeRepositoryIntelligence(
  input: RepositoryIntelligenceBuildInput,
): RepositoryIntelligenceSnapshot {
  const intelligenceVersion = deterministicIntelligenceVersion(input);
  const files = [...input.files].sort((a, b) => a.filePath.localeCompare(b.filePath));
  const filePaths = sortedUnique([
    ...files.map((file) => file.filePath),
    ...input.nodes.map((node) => node.file).filter(Boolean),
  ]);
  const fileSize = new Map(files.map((file) => [file.filePath, file.size]));
  const nodeFile = fileForNodeId(input);
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  const dependencyPairs = new Map<string, number>();
  const referencedNodes = new Set<string>();

  for (const edge of [...input.edges].sort((a, b) => a.edgeId.localeCompare(b.edgeId))) {
    referencedNodes.add(edge.fromNodeId);
    referencedNodes.add(edge.toNodeId);
    if (!["imports", "references", "calls", "extends", "implements", "re_exports"].includes(edge.kind)) continue;
    const from = nodeFile.get(edge.fromNodeId);
    const to = nodeFile.get(edge.toNodeId);
    if (!from || !to || from === to) continue;
    outgoing.set(from, (outgoing.get(from) ?? 0) + 1);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
    adjacency.set(from, sortedUnique([...(adjacency.get(from) ?? []), to]));
    const fromSubsystem = subsystemId(subsystemRoot(from));
    const toSubsystem = subsystemId(subsystemRoot(to));
    if (fromSubsystem !== toSubsystem) {
      const key = `${fromSubsystem}\0${toSubsystem}`;
      dependencyPairs.set(key, (dependencyPairs.get(key) ?? 0) + 1);
    }
  }

  const publicNodes = input.nodes.filter((node) =>
    node.exported && !FILE_NODE_KINDS.has(node.kind));
  const internalNodes = input.nodes.filter((node) =>
    !node.exported && !FILE_NODE_KINDS.has(node.kind) && node.kind !== "imported_member");
  const publicApis = [...publicNodes]
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name))
    .map(({ name, qualifiedName, kind, file, line }) => ({ name, qualifiedName, kind, file, line }));
  const internalApis = [...internalNodes]
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name))
    .map(({ name, qualifiedName, kind, file, line }) => ({ name, qualifiedName, kind, file, line }));
  const entrypoints = sortedUnique([
    ...filePaths.filter((path) => ENTRYPOINT.test(path)),
    ...input.nodes.filter((node) => node.defaultExport).map((node) => node.file),
  ]);

  const roots = sortedUnique(filePaths.map(subsystemRoot));
  const subsystems: RepositorySubsystemSummary[] = roots.map((root) => {
    const paths = filePaths.filter((path) => subsystemRoot(path) === root);
    const id = subsystemId(root);
    const dependencies = sortedUnique([...dependencyPairs.keys()]
      .filter((key) => key.startsWith(`${id}\0`))
      .map((key) => key.split("\0")[1]!));
    const symbols = input.nodes.filter((node) => paths.includes(node.file) && !FILE_NODE_KINDS.has(node.kind));
    const layerCounts = new Map<string, number>();
    for (const path of paths) layerCounts.set(layerFor(path), (layerCounts.get(layerFor(path)) ?? 0) + 1);
    const layer = [...layerCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "unclassified";
    const outgoingDependencies = [...dependencyPairs].filter(([key]) => key.startsWith(`${id}\0`))
      .reduce((sum, [, count]) => sum + count, 0);
    const incomingDependencies = [...dependencyPairs].filter(([key]) => key.endsWith(`\0${id}`))
      .reduce((sum, [, count]) => sum + count, 0);
    return {
      subsystemId: id,
      name: root === "." ? "root" : root.split("/").at(-1)!,
      rootPath: root,
      layer,
      files: paths,
      dependencies,
      publicApis: publicApis.filter((api) => paths.includes(api.file)).map((api) => api.qualifiedName),
      entrypoints: entrypoints.filter((path) => paths.includes(path)),
      summary: `${paths.length} files; ${symbols.length} symbols; ${outgoingDependencies} outgoing dependencies`,
      metrics: { files: paths.length, symbols: symbols.length, incomingDependencies, outgoingDependencies },
    };
  }).sort((a, b) => a.subsystemId.localeCompare(b.subsystemId));

  const layers = sortedUnique(filePaths.map(layerFor)).map((name) => ({
    name,
    paths: filePaths.filter((path) => layerFor(path) === name),
  }));
  const centrality = new Map(filePaths.map((path) => [
    path,
    (incoming.get(path) ?? 0) * 2 + (outgoing.get(path) ?? 0),
  ]));
  const signatures = new Map<string, string[]>();
  for (const node of input.nodes.filter((item) =>
    ["function", "method", "class"].includes(item.kind))) {
    const signature = `${node.kind}:${node.name}:${Math.max(0, node.endLine - node.line + 1)}`;
    signatures.set(signature, sortedUnique([...(signatures.get(signature) ?? []), node.qualifiedName]));
  }
  const duplicateImplementations = [...signatures]
    .filter(([, symbols]) => symbols.length > 1)
    .map(([signature, symbols]) => ({ signature, symbols }))
    .sort((a, b) => a.signature.localeCompare(b.signature));
  const oversizedFunctions = rank(new Map(input.nodes
    .filter((node) => ["function", "method", "constructor"].includes(node.kind))
    .map((node) => [`${node.file}:${node.line}:${node.qualifiedName}`, node.endLine - node.line + 1])
    .filter(([, lines]) => (lines as number) >= 80) as Array<[string, number]>));
  const oversizedFiles = rank(new Map([...fileSize].filter(([, size]) => size >= 50_000)));
  const contentBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content ?? "", "utf8"), 0);
  const todoCount = files.reduce((sum, file) =>
    sum + ((file.content ?? "").match(/\b(?:TODO|FIXME)\b/gu)?.length ?? 0), 0);
  const generatedFiles = filePaths.filter((path) => GENERATED.test(path));
  const documentedSymbols = input.nodes.filter((node) =>
    node.metadata.documented === true || DOC.test(node.file)).length;
  const previous = input.previous ?? null;
  const changed = new Set(input.changedFiles ?? []);
  const changedHotspots = rank(new Map(filePaths
    .filter((path) => changed.has(path))
    .map((path) => [path, centrality.get(path) ?? 0])));
  const previousSubsystems = new Map(previous?.subsystems.map((item) => [item.subsystemId, item]) ?? []);
  const architecturalDrift = subsystems.map((subsystem) => ({
    subsystemId: subsystem.subsystemId,
    dependencyDelta: subsystem.metrics.outgoingDependencies -
      (previousSubsystems.get(subsystem.subsystemId)?.metrics.outgoingDependencies ?? 0),
  })).filter((item) => item.dependencyDelta !== 0);
  const dependencyGraph = [...dependencyPairs].map(([key, count]) => {
    const [from, to] = key.split("\0");
    return { from: from!, to: to!, count };
  }).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const qualityFindings = duplicateImplementations.length + oversizedFiles.length +
    oversizedFunctions.length + todoCount;

  return {
    intelligenceVersion,
    repositoryId: input.repositoryId,
    repositoryRevision: input.repositoryRevision,
    graphVersion: input.graphVersion,
    embeddingVersion: input.embeddingVersion,
    parserVersion: input.parserVersion,
    analysisVersion: REPOSITORY_INTELLIGENCE_ANALYSIS_VERSION,
    schemaVersion: REPOSITORY_INTELLIGENCE_SCHEMA_VERSION,
    architecture: {
      subsystemIds: subsystems.map((item) => item.subsystemId),
      packageHierarchy: sortedUnique(filePaths.flatMap((path) => {
        const parts = path.split("/").slice(0, -1);
        return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
      })),
      dependencyGraph,
      layers,
      hotspots: rank(centrality),
    },
    codeOrganization: {
      largestModules: rank(fileSize),
      mostImportedFiles: rank(incoming),
      highestFanIn: rank(incoming),
      highestFanOut: rank(outgoing),
      cyclicDependencies: findCycles(adjacency),
      utilityClusters: roots.map((root) => ({
        name: root,
        files: filePaths.filter((path) => subsystemRoot(path) === root && UTILITY.test(path)),
      })).filter((cluster) => cluster.files.length > 0),
    },
    symbols: {
      publicApis,
      internalApis,
      orphanSymbols: sortedUnique(input.nodes
        .filter((node) => !FILE_NODE_KINDS.has(node.kind) && !referencedNodes.has(node.nodeId))
        .map((node) => node.qualifiedName)),
      deadExports: sortedUnique(publicNodes
        .filter((node) => !input.edges.some((edge) =>
          edge.toNodeId === node.nodeId && ["imports", "references", "calls"].includes(edge.kind)))
        .map((node) => node.qualifiedName)),
      entrypoints,
      sharedAbstractions: sortedUnique(input.nodes
        .filter((node) => ["interface", "type", "type_alias"].includes(node.kind) &&
          (incoming.get(node.file) ?? 0) > 1)
        .map((node) => node.qualifiedName)),
    },
    quality: {
      duplicateImplementations,
      oversizedFiles,
      oversizedFunctions,
      todoFixmeDensity: contentBytes > 0 ? todoCount / (contentBytes / 1_000) : 0,
      generatedCodeRatio: filePaths.length > 0 ? generatedFiles.length / filePaths.length : 0,
      documentationCoverage: input.nodes.length > 0 ? documentedSymbols / input.nodes.length : 0,
    },
    evolution: {
      changedHotspots,
      stableAreas: filePaths.filter((path) => !changed.has(path)),
      architecturalDrift,
      growth: {
        files: filePaths.length,
        symbols: input.nodes.length,
        dependencyEdges: input.edges.length,
        fileDelta: filePaths.length - (previous?.evolution.growth.files ?? filePaths.length),
        symbolDelta: input.nodes.length - (previous?.evolution.growth.symbols ?? input.nodes.length),
        dependencyEdgeDelta: input.edges.length -
          (previous?.evolution.growth.dependencyEdges ?? input.edges.length),
      },
    },
    subsystems,
    metrics: {
      filesAnalyzed: filePaths.length,
      symbolsAnalyzed: input.nodes.length,
      dependencyEdgesAnalyzed: input.edges.length,
      generatedSubsystems: subsystems.length,
      qualityFindings,
      hotspots: centrality.size,
    },
  };
}
