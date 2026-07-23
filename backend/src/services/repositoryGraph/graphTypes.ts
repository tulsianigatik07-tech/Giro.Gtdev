import type { FileSymbolMap } from "../graph/types.js";

export const REPOSITORY_GRAPH_PARSER_VERSION = "typescript-compiler-v1";
export const REPOSITORY_GRAPH_SCHEMA_VERSION = "repository-graph-v1";

export type RepositoryGraphStatus =
  | "building"
  | "validating"
  | "published"
  | "failed"
  | "superseded";

export type RepositoryGraphNodeKind =
  | "repository"
  | "file"
  | "module"
  | "symbol"
  | "class"
  | "interface"
  | "function"
  | "method"
  | "constructor"
  | "enum"
  | "variable"
  | "constant"
  | "type"
  | "type_alias"
  | "namespace"
  | "imported_member"
  | "exported_member"
  | "struct";

export type RepositoryGraphEdgeKind =
  | "contains"
  | "imports"
  | "exports"
  | "re_exports"
  | "references"
  | "calls"
  | "extends"
  | "implements"
  | "overrides"
  | "resolves_to"
  // Kept for compatibility with the pre-durable symbol graph.
  | "overriddenBy"
  | "parent"
  | "child";

export interface RepositoryGraphNode {
  nodeId: string;
  /** Compatibility alias for existing symbol/path retrieval consumers. */
  symbolId: string;
  graphVersion: string;
  repositoryId: string;
  repositoryRevision: string;
  repositoryVersion: string;
  parserVersion: string;
  name: string;
  qualifiedName: string;
  kind: RepositoryGraphNodeKind;
  language: string;
  file: string;
  line: number;
  endLine: number;
  column: number;
  endColumn: number;
  exported: boolean;
  defaultExport: boolean;
  metadata: Record<string, unknown>;
}

export interface RepositoryGraphEdge {
  edgeId: string;
  graphVersion: string;
  repositoryId: string;
  repositoryRevision: string;
  parserVersion: string;
  fromNodeId: string;
  toNodeId: string;
  /** Compatibility aliases for existing graph consumers. */
  fromSymbolId: string;
  toSymbolId: string;
  kind: RepositoryGraphEdgeKind;
  distance: number;
  metadata: Record<string, unknown>;
}

export interface RepositoryGraphDiagnostics {
  parsedFileCount: number;
  parserFailureCount: number;
  unresolvedImportCount: number;
  importCount: number;
  unresolvedFileRatio: number;
  parserFailureRatio: number;
  orphanSymbolCount: number;
  duplicateNodeIdCount: number;
  duplicateEdgeIdCount: number;
  missingEndpointCount: number;
  impossibleSelfEdgeCount: number;
  graphBytes: number;
  durationMs: number;
  failures: Array<{
    file?: string;
    code: string;
    message: string;
  }>;
}

export interface RepositoryGraphValidation extends RepositoryGraphDiagnostics {
  valid: boolean;
  nodeCount: number;
  edgeCount: number;
  validatedAt: string;
}

export interface RepositorySymbolGraph {
  graphVersion: string;
  repositoryId: string;
  repositoryRevision: string;
  repositoryVersion: string;
  parserVersion: string;
  status: RepositoryGraphStatus;
  createdAt: string;
  publishedAt: string | null;
  nodes: RepositoryGraphNode[];
  edges: RepositoryGraphEdge[];
  diagnostics: RepositoryGraphDiagnostics;
}

export interface RepositoryGraphBuildInput {
  repositoryId: string;
  repositoryVersion: string;
  repositoryRevision?: string;
  parserVersion?: string;
  symbolMaps: readonly FileSymbolMap[];
}

export interface RepositoryGraphQuotas {
  maxNodes: number;
  maxEdges: number;
  maxDurationMs: number;
  maxBytes: number;
  maxUnresolvedFileRatio: number;
  maxParserFailureRatio: number;
}

export interface RepositoryGraphExpansionMetrics {
  incrementSymbolExpansion(count?: number): void;
  incrementSymbolExpansionBudgetDrop(count?: number): void;
  incrementGraphExpansionUsage?(count?: number): void;
  incrementGraphExpandedCandidates?(count?: number): void;
  observeGraphRetrievalDurationMs?(milliseconds: number): void;
}

export interface RepositoryGraphLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn?(event: string, fields?: Record<string, unknown>): void;
  error?(event: string, fields?: Record<string, unknown>): void;
}

export interface ParsedGraphSymbol {
  key: string;
  name: string;
  qualifiedName: string;
  kind: RepositoryGraphNodeKind;
  filePath: string;
  language: "typescript" | "javascript";
  line: number;
  endLine: number;
  column: number;
  endColumn: number;
  exported: boolean;
  defaultExport: boolean;
  parentKey: string | null;
  extendsNames: string[];
  implementsNames: string[];
  calls: string[];
  references: string[];
}

export interface ParsedGraphImport {
  source: string;
  line: number;
  importedName: string;
  localName: string;
  reExport: boolean;
  exportAll: boolean;
}

export interface ParsedGraphFile {
  filePath: string;
  language: "typescript" | "javascript";
  symbols: ParsedGraphSymbol[];
  imports: ParsedGraphImport[];
  parserFailures: Array<{ code: string; message: string }>;
}

export interface RepositoryLanguageParser {
  readonly parserVersion: string;
  supports(filePath: string): boolean;
  parse(filePath: string, source: string): ParsedGraphFile;
}
