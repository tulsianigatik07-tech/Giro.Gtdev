import { createHash } from "node:crypto";
import type { ExtractedSymbol } from "../graph/types.js";
import {
  REPOSITORY_GRAPH_PARSER_VERSION,
  REPOSITORY_GRAPH_SCHEMA_VERSION,
  type ParsedGraphFile,
  type ParsedGraphSymbol,
  type RepositoryGraphBuildInput,
  type RepositoryGraphDiagnostics,
  type RepositoryGraphEdge,
  type RepositoryGraphEdgeKind,
  type RepositoryGraphNode,
  type RepositoryGraphNodeKind,
  type RepositorySymbolGraph,
} from "./graphTypes.js";

const RESOLVE_SUFFIXES = [
  "", ".ts", ".tsx", ".js", ".jsx",
  "/index.ts", "/index.tsx", "/index.js", "/index.jsx",
];

function hash(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function deterministicGraphVersion(
  repositoryId: string,
  repositoryRevision: string,
  parserVersion = REPOSITORY_GRAPH_PARSER_VERSION,
): string {
  return hash([
    REPOSITORY_GRAPH_SCHEMA_VERSION,
    repositoryId,
    repositoryRevision,
    parserVersion,
  ]);
}

export function deterministicGraphNodeId(input: {
  repositoryId: string;
  repositoryRevision: string;
  parserVersion: string;
  filePath: string;
  kind: RepositoryGraphNodeKind;
  name: string;
  line?: number;
  column?: number;
}): string {
  return hash([
    "node",
    input.repositoryId,
    input.repositoryRevision,
    input.parserVersion,
    input.filePath,
    input.kind,
    input.name,
    input.line ?? 0,
    input.column ?? 0,
  ]);
}

function deterministicGraphEdgeId(input: {
  repositoryId: string;
  repositoryRevision: string;
  parserVersion: string;
  fromNodeId: string;
  toNodeId: string;
  kind: RepositoryGraphEdgeKind;
}): string {
  return hash([
    "edge",
    input.repositoryId,
    input.repositoryRevision,
    input.parserVersion,
    input.fromNodeId,
    input.toNodeId,
    input.kind,
  ]);
}

function normalizePath(value: string): string {
  const parts: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

function dirname(value: string): string {
  const index = value.lastIndexOf("/");
  return index < 0 ? "" : value.slice(0, index);
}

function resolveImport(fromFile: string, source: string, knownFiles: Set<string>): string | null {
  if (!source.startsWith(".")) return null;
  const base = normalizePath(`${dirname(fromFile)}/${source}`);
  const variants = new Set([base, base.replace(/\.(mjs|cjs|js|jsx)$/, "")]);
  for (const variant of variants) {
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = normalizePath(`${variant}${suffix}`);
      if (knownFiles.has(candidate)) return candidate;
    }
  }
  return null;
}

function emptyDiagnostics(): RepositoryGraphDiagnostics {
  return {
    parsedFileCount: 0,
    parserFailureCount: 0,
    unresolvedImportCount: 0,
    importCount: 0,
    unresolvedFileRatio: 0,
    parserFailureRatio: 0,
    orphanSymbolCount: 0,
    duplicateNodeIdCount: 0,
    duplicateEdgeIdCount: 0,
    missingEndpointCount: 0,
    impossibleSelfEdgeCount: 0,
    graphBytes: 0,
    durationMs: 0,
    failures: [],
  };
}

function makeNode(input: {
  repositoryId: string;
  repositoryRevision: string;
  parserVersion: string;
  graphVersion: string;
  name: string;
  qualifiedName?: string;
  kind: RepositoryGraphNodeKind;
  language?: string;
  file?: string;
  line?: number;
  endLine?: number;
  column?: number;
  endColumn?: number;
  exported?: boolean;
  defaultExport?: boolean;
  metadata?: Record<string, unknown>;
}): RepositoryGraphNode {
  const nodeId = deterministicGraphNodeId({
    repositoryId: input.repositoryId,
    repositoryRevision: input.repositoryRevision,
    parserVersion: input.parserVersion,
    filePath: input.file ?? "",
    kind: input.kind,
    name: input.name,
    line: input.line,
    column: input.column,
  });
  return {
    nodeId,
    symbolId: nodeId,
    graphVersion: input.graphVersion,
    repositoryId: input.repositoryId,
    repositoryRevision: input.repositoryRevision,
    repositoryVersion: input.repositoryRevision,
    parserVersion: input.parserVersion,
    name: input.name,
    qualifiedName: input.qualifiedName ?? input.name,
    kind: input.kind,
    language: input.language ?? "unknown",
    file: input.file ?? "",
    line: input.line ?? 1,
    endLine: input.endLine ?? input.line ?? 1,
    column: input.column ?? 1,
    endColumn: input.endColumn ?? input.column ?? 1,
    exported: input.exported ?? false,
    defaultExport: input.defaultExport ?? false,
    metadata: input.metadata ?? {},
  };
}

function addEdge(
  edges: RepositoryGraphEdge[],
  seen: Set<string>,
  context: {
    repositoryId: string;
    repositoryRevision: string;
    parserVersion: string;
    graphVersion: string;
  },
  fromNodeId: string,
  toNodeId: string,
  kind: RepositoryGraphEdgeKind,
  metadata: Record<string, unknown> = {},
): void {
  if (fromNodeId === toNodeId && kind !== "references") return;
  const edgeId = deterministicGraphEdgeId({ ...context, fromNodeId, toNodeId, kind });
  if (seen.has(edgeId)) return;
  seen.add(edgeId);
  edges.push({
    edgeId,
    graphVersion: context.graphVersion,
    repositoryId: context.repositoryId,
    repositoryRevision: context.repositoryRevision,
    parserVersion: context.parserVersion,
    fromNodeId,
    toNodeId,
    fromSymbolId: fromNodeId,
    toSymbolId: toNodeId,
    kind,
    distance: 1,
    metadata,
  });
}

function sortGraph(graph: RepositorySymbolGraph): RepositorySymbolGraph {
  return {
    ...graph,
    nodes: [...graph.nodes].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    edges: [...graph.edges].sort((left, right) => left.edgeId.localeCompare(right.edgeId)),
  };
}

function symbolLookupName(value: string): string {
  const cleaned = value.replace(/\?.*$/, "");
  return cleaned.split(/[.(<\[]/).filter(Boolean).at(-1) ?? cleaned;
}

function resolveNamedNode(
  name: string,
  owner: ParsedGraphSymbol,
  byName: Map<string, RepositoryGraphNode[]>,
  byQualifiedName: Map<string, RepositoryGraphNode>,
): RepositoryGraphNode | null {
  const direct = byQualifiedName.get(name) ?? byQualifiedName.get(`${owner.qualifiedName}.${name}`);
  if (direct) return direct;
  const candidates = byName.get(symbolLookupName(name)) ?? [];
  return candidates.find((candidate) => candidate.file === owner.filePath) ?? candidates[0] ?? null;
}

export function buildAstRepositoryGraph(input: {
  repositoryId: string;
  repositoryRevision: string;
  parsedFiles: readonly ParsedGraphFile[];
  parserVersion?: string;
  durationMs?: number;
  createdAt?: string;
}): RepositorySymbolGraph {
  const parserVersion = input.parserVersion ?? REPOSITORY_GRAPH_PARSER_VERSION;
  const graphVersion = deterministicGraphVersion(
    input.repositoryId,
    input.repositoryRevision,
    parserVersion,
  );
  const context = {
    repositoryId: input.repositoryId,
    repositoryRevision: input.repositoryRevision,
    parserVersion,
    graphVersion,
  };
  const nodes: RepositoryGraphNode[] = [];
  const edges: RepositoryGraphEdge[] = [];
  const edgeIds = new Set<string>();
  const knownFiles = new Set(input.parsedFiles.map((file) => file.filePath));
  const moduleByFile = new Map<string, RepositoryGraphNode>();
  const fileByPath = new Map<string, RepositoryGraphNode>();
  const symbolByKey = new Map<string, RepositoryGraphNode>();
  const symbolsByName = new Map<string, RepositoryGraphNode[]>();
  const symbolByQualifiedName = new Map<string, RepositoryGraphNode>();
  const diagnostics = emptyDiagnostics();
  diagnostics.parsedFileCount = input.parsedFiles.length;
  diagnostics.durationMs = input.durationMs ?? 0;

  const repositoryNode = makeNode({
    ...context,
    name: input.repositoryId,
    kind: "repository",
  });
  nodes.push(repositoryNode);

  for (const file of [...input.parsedFiles].sort((left, right) =>
    left.filePath.localeCompare(right.filePath))) {
    diagnostics.parserFailureCount += file.parserFailures.length > 0 ? 1 : 0;
    diagnostics.failures.push(...file.parserFailures.map((failure) => ({
      file: file.filePath,
      ...failure,
    })));
    const fileNode = makeNode({
      ...context,
      name: file.filePath,
      qualifiedName: file.filePath,
      kind: "file",
      language: file.language,
      file: file.filePath,
    });
    const moduleNode = makeNode({
      ...context,
      name: file.filePath,
      qualifiedName: file.filePath,
      kind: "module",
      language: file.language,
      file: file.filePath,
    });
    nodes.push(fileNode, moduleNode);
    fileByPath.set(file.filePath, fileNode);
    moduleByFile.set(file.filePath, moduleNode);
    addEdge(edges, edgeIds, context, repositoryNode.nodeId, fileNode.nodeId, "contains");
    addEdge(edges, edgeIds, context, fileNode.nodeId, moduleNode.nodeId, "contains");

    for (const symbol of file.symbols) {
      const node = makeNode({
        ...context,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        kind: symbol.kind,
        language: symbol.language,
        file: symbol.filePath,
        line: symbol.line,
        endLine: symbol.endLine,
        column: symbol.column,
        endColumn: symbol.endColumn,
        exported: symbol.exported,
        defaultExport: symbol.defaultExport,
      });
      nodes.push(node);
      symbolByKey.set(symbol.key, node);
      symbolByQualifiedName.set(symbol.qualifiedName, node);
      const named = symbolsByName.get(symbol.name) ?? [];
      named.push(node);
      symbolsByName.set(symbol.name, named);
      const parent = symbol.parentKey ? symbolByKey.get(symbol.parentKey) : moduleNode;
      addEdge(edges, edgeIds, context, (parent ?? moduleNode).nodeId, node.nodeId, "contains");
      if (symbol.exported) addEdge(edges, edgeIds, context, moduleNode.nodeId, node.nodeId, "exports", {
        default: symbol.defaultExport,
      });
    }
  }

  let localImportCount = 0;
  let unresolvedLocalImportCount = 0;
  for (const file of input.parsedFiles) {
    const fromModule = moduleByFile.get(file.filePath);
    if (!fromModule) continue;
    for (const imported of file.imports) {
      diagnostics.importCount += 1;
      const localImport = imported.source.startsWith(".");
      if (localImport) localImportCount += 1;
      const targetFile = resolveImport(file.filePath, imported.source, knownFiles);
      const targetModule = targetFile ? moduleByFile.get(targetFile) : null;
      if (!targetModule) {
        diagnostics.unresolvedImportCount += 1;
        if (localImport) unresolvedLocalImportCount += 1;
        diagnostics.failures.push({
          file: file.filePath,
          code: "unresolved_import",
          message: imported.source,
        });
        continue;
      }
      addEdge(
        edges,
        edgeIds,
        context,
        fromModule.nodeId,
        targetModule.nodeId,
        imported.reExport ? "re_exports" : "imports",
        { source: imported.source, importedName: imported.importedName },
      );
      if (imported.exportAll) continue;
      const targets = (symbolsByName.get(imported.importedName) ?? [])
        .filter((node) => node.file === targetFile);
      const target = imported.importedName === "default"
        ? [...symbolByKey.entries()]
            .find(([key, node]) => key.startsWith(`${targetFile}\u0000`) && node.defaultExport)?.[1]
        : targets[0];
      if (!target) continue;
      const importedNode = makeNode({
        ...context,
        name: imported.localName,
        qualifiedName: `${file.filePath}.${imported.localName}`,
        kind: "imported_member",
        language: file.language,
        file: file.filePath,
        line: imported.line,
        exported: imported.reExport,
        metadata: { source: imported.source, importedName: imported.importedName },
      });
      if (!nodes.some((node) => node.nodeId === importedNode.nodeId)) nodes.push(importedNode);
      addEdge(edges, edgeIds, context, fromModule.nodeId, importedNode.nodeId, "contains");
      addEdge(edges, edgeIds, context, importedNode.nodeId, target.nodeId, "resolves_to");
      if (imported.reExport) addEdge(edges, edgeIds, context, fromModule.nodeId, target.nodeId, "re_exports");
    }

    for (const symbol of file.symbols) {
      const from = symbolByKey.get(symbol.key);
      if (!from) continue;
      for (const name of symbol.extendsNames) {
        const target = resolveNamedNode(name, symbol, symbolsByName, symbolByQualifiedName);
        if (target) addEdge(edges, edgeIds, context, from.nodeId, target.nodeId, "extends");
      }
      for (const name of symbol.implementsNames) {
        const target = resolveNamedNode(name, symbol, symbolsByName, symbolByQualifiedName);
        if (target) addEdge(edges, edgeIds, context, from.nodeId, target.nodeId, "implements");
      }
      for (const name of symbol.calls) {
        const target = resolveNamedNode(name, symbol, symbolsByName, symbolByQualifiedName);
        if (target) addEdge(edges, edgeIds, context, from.nodeId, target.nodeId, "calls");
      }
      for (const name of symbol.references) {
        const target = resolveNamedNode(name, symbol, symbolsByName, symbolByQualifiedName);
        if (target) addEdge(edges, edgeIds, context, from.nodeId, target.nodeId, "references");
      }
    }
  }

  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  for (const edge of [...edges]) {
    if (edge.kind !== "extends") continue;
    const childClass = nodeById.get(edge.fromNodeId);
    const baseClass = nodeById.get(edge.toNodeId);
    if (!childClass || !baseClass) continue;
    const childMethods = nodes.filter((node) =>
      node.kind === "method" && node.qualifiedName.startsWith(`${childClass.qualifiedName}.`));
    const baseMethods = nodes.filter((node) =>
      node.kind === "method" && node.qualifiedName.startsWith(`${baseClass.qualifiedName}.`));
    for (const method of childMethods) {
      const base = baseMethods.find((candidate) => candidate.name === method.name);
      if (base) addEdge(edges, edgeIds, context, method.nodeId, base.nodeId, "overrides");
    }
  }

  const containedTargets = new Set(edges.filter((edge) => edge.kind === "contains")
    .map((edge) => edge.toNodeId));
  diagnostics.orphanSymbolCount = nodes.filter((node) =>
    !["repository", "file"].includes(node.kind) && !containedTargets.has(node.nodeId)).length;
  diagnostics.unresolvedFileRatio = localImportCount === 0
    ? 0
    : unresolvedLocalImportCount / localImportCount;
  diagnostics.parserFailureRatio = input.parsedFiles.length === 0
    ? 0
    : diagnostics.parserFailureCount / input.parsedFiles.length;
  const sorted = sortGraph({
    graphVersion,
    repositoryId: input.repositoryId,
    repositoryRevision: input.repositoryRevision,
    repositoryVersion: input.repositoryRevision,
    parserVersion,
    status: "building",
    createdAt: input.createdAt ?? new Date().toISOString(),
    publishedAt: null,
    nodes,
    edges,
    diagnostics,
  });
  sorted.diagnostics.graphBytes = Buffer.byteLength(JSON.stringify({
    nodes: sorted.nodes,
    edges: sorted.edges,
    diagnostics: sorted.diagnostics,
  }));
  return sorted;
}

function legacyKind(symbol: ExtractedSymbol): RepositoryGraphNodeKind {
  return symbol.kind === "variable"
    ? symbol.exported ? "exported_member" : "constant"
    : symbol.kind;
}

/**
 * Compatibility builder for the existing regex symbol extractor. New indexing
 * uses buildAstRepositoryGraph; keeping this adapter preserves existing internal
 * consumers while giving them deterministic revision/parser-bound identities.
 */
export function buildRepositorySymbolGraph(input: RepositoryGraphBuildInput): RepositorySymbolGraph {
  const repositoryRevision = input.repositoryRevision ?? input.repositoryVersion;
  const parserVersion = input.parserVersion ?? "legacy-symbol-map-v1";
  const graphVersion = deterministicGraphVersion(
    input.repositoryId,
    repositoryRevision,
    parserVersion,
  );
  const context = {
    repositoryId: input.repositoryId,
    repositoryRevision,
    parserVersion,
    graphVersion,
  };
  const nodes: RepositoryGraphNode[] = [];
  const edges: RepositoryGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const modules = new Map<string, RepositoryGraphNode>();
  const symbolsByName = new Map<string, RepositoryGraphNode[]>();
  const exported = new Map<string, RepositoryGraphNode>();
  const knownFiles = new Set(input.symbolMaps.map((map) => map.filePath));

  const legacyEdge = (
    from: string,
    to: string,
    kind: RepositoryGraphEdgeKind,
  ): void => {
    if (from === to) return;
    const key = `${from}\u0000${to}\u0000${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    const edge = { fromSymbolId: from, toSymbolId: to, kind } as RepositoryGraphEdge;
    const hidden = {
      edgeId: deterministicGraphEdgeId({
        ...context,
        fromNodeId: from,
        toNodeId: to,
        kind,
      }),
      graphVersion,
      repositoryId: input.repositoryId,
      repositoryRevision,
      parserVersion,
      fromNodeId: from,
      toNodeId: to,
      distance: 1,
      metadata: {},
    };
    for (const [name, value] of Object.entries(hidden)) {
      Object.defineProperty(edge, name, { value, enumerable: false });
    }
    edges.push(edge);
  };

  for (const map of input.symbolMaps) {
    const module = makeNode({
      ...context,
      name: map.filePath,
      qualifiedName: map.filePath,
      kind: "module",
      language: map.language,
      file: map.filePath,
    });
    modules.set(map.filePath, module);
    nodes.push(module);
    for (const symbol of map.symbols) {
      const node = makeNode({
        ...context,
        name: symbol.name,
        qualifiedName: symbol.name,
        kind: legacyKind(symbol),
        language: map.language,
        file: map.filePath,
        line: symbol.line,
        exported: symbol.exported,
      });
      nodes.push(node);
      const named = symbolsByName.get(symbol.name) ?? [];
      named.push(node);
      symbolsByName.set(symbol.name, named);
      if (symbol.exported) exported.set(`${map.filePath}\u0000${symbol.name}`, node);
      legacyEdge(module.nodeId, node.nodeId, "child");
      legacyEdge(node.nodeId, module.nodeId, "parent");
      if (symbol.exported) legacyEdge(module.nodeId, node.nodeId, "exports");
    }
  }

  for (const map of input.symbolMaps) {
    const module = modules.get(map.filePath);
    if (!module) continue;
    for (const symbol of map.symbols) {
      const from = nodes.find((node) =>
        node.file === map.filePath &&
        node.name === symbol.name &&
        node.line === symbol.line &&
        node.kind === legacyKind(symbol));
      if (!from) continue;
      for (const parent of symbol.extends ?? []) {
        for (const target of symbolsByName.get(parent) ?? []) {
          legacyEdge(from.nodeId, target.nodeId, "extends");
          legacyEdge(from.nodeId, target.nodeId, "references");
        }
      }
      for (const implemented of symbol.implements ?? []) {
        for (const target of symbolsByName.get(implemented) ?? []) {
          legacyEdge(from.nodeId, target.nodeId, "implements");
          legacyEdge(from.nodeId, target.nodeId, "references");
        }
      }
    }
    for (const imported of map.imports) {
      if (!imported.isRelative) continue;
      const targetFile = resolveImport(map.filePath, imported.source, knownFiles);
      const targetModule = targetFile ? modules.get(targetFile) : null;
      if (!targetFile || !targetModule) continue;
      legacyEdge(module.nodeId, targetModule.nodeId, "imports");
      for (const specifier of imported.specifiers) {
        const importedNode = makeNode({
          ...context,
          name: specifier,
          qualifiedName: specifier,
          kind: "imported_member",
          language: map.language,
          file: map.filePath,
          line: imported.line ?? 1,
        });
        nodes.push(importedNode);
        legacyEdge(module.nodeId, importedNode.nodeId, "child");
        legacyEdge(importedNode.nodeId, module.nodeId, "parent");
        const target = exported.get(`${targetFile}\u0000${specifier}`);
        if (target) {
          legacyEdge(importedNode.nodeId, target.nodeId, "imports");
          legacyEdge(importedNode.nodeId, target.nodeId, "references");
          legacyEdge(module.nodeId, target.nodeId, "references");
        }
      }
    }
  }

  nodes.sort((left, right) =>
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.name.localeCompare(right.name) ||
    left.nodeId.localeCompare(right.nodeId));
  edges.sort((left, right) =>
    left.fromSymbolId.localeCompare(right.fromSymbolId) ||
    left.toSymbolId.localeCompare(right.toSymbolId) ||
    left.kind.localeCompare(right.kind));
  return {
    graphVersion,
    repositoryId: input.repositoryId,
    repositoryRevision,
    repositoryVersion: repositoryRevision,
    parserVersion,
    status: "building",
    createdAt: new Date().toISOString(),
    publishedAt: null,
    nodes,
    edges,
    diagnostics: emptyDiagnostics(),
  };
}
