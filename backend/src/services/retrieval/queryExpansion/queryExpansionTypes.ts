export type QueryExpansionSource =
  | "symbol_alias"
  | "framework_alias"
  | "module_alias"
  | "api_alias"
  | "import_relationship"
  | "graph_relationship"
  | "parent_module"
  | "repository_summary"
  | "exported_symbol"
  | "filename"
  | "package_metadata";

export interface QueryExpansionTerm {
  term: string;
  source: QueryExpansionSource;
  scoreMultiplier: number;
}

export interface QueryExpansionSymbol {
  name: string;
  filePath: string;
  exported: boolean;
}

export interface QueryExpansionImport {
  fromFile: string;
  source: string;
  importedSymbols: readonly string[];
  isRelative: boolean;
}

export interface QueryExpansionGraphRelation {
  from: string;
  to: string;
  kind: string;
}

export interface QueryExpansionMetadata {
  frameworks: readonly string[];
  modules: readonly string[];
  services: readonly string[];
  apiRoutes: readonly string[];
  packages: readonly string[];
  filenames: readonly string[];
  symbols: readonly QueryExpansionSymbol[];
  imports: readonly QueryExpansionImport[];
  graphRelations: readonly QueryExpansionGraphRelation[];
}

export interface QueryExpansionInput {
  repositoryId: string;
  repositoryVersion: string;
  query: string;
  metadata: QueryExpansionMetadata;
  maxTerms: number;
  expandedScoreMultiplier: number;
}

export interface QueryExpansionResult {
  primaryQuery: string;
  expandedQuery: string;
  terms: readonly QueryExpansionTerm[];
  repositoryVersion: string;
  expandedScoreMultiplier: number;
}

export interface QueryExpansionMetrics {
  incrementQueryExpansions(count?: number): void;
  incrementQueryExpansionTerms(count?: number): void;
  incrementQueryExpansionCacheHits(count?: number): void;
}

export interface QueryExpansionLogger {
  info(event: string, fields?: Record<string, unknown>): void;
}
