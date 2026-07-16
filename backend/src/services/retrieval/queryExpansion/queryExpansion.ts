import { createHash } from "node:crypto";

import type {
  QueryExpansionInput,
  QueryExpansionLogger,
  QueryExpansionMetadata,
  QueryExpansionMetrics,
  QueryExpansionResult,
  QueryExpansionSource,
  QueryExpansionTerm,
} from "./queryExpansionTypes.js";

const SOURCE_ORDER: readonly QueryExpansionSource[] = [
  "symbol_alias",
  "framework_alias",
  "module_alias",
  "api_alias",
  "import_relationship",
  "graph_relationship",
  "parent_module",
  "repository_summary",
  "exported_symbol",
  "filename",
  "package_metadata",
];

const SYMBOL_ALIAS_FAMILIES = [
  ["login", "authenticate", "authentication", "auth", "signin", "sign_in"],
  ["logout", "signout", "sign_out", "deauthenticate"],
  ["user", "users", "account", "profile"],
] as const;

const MODULE_ALIAS_FAMILIES = [
  ["payment", "payments", "billing", "invoice", "checkout"],
  ["order", "orders", "purchase", "cart", "checkout"],
  ["notification", "notifications", "message", "messaging", "email"],
] as const;

const API_ALIASES = ["api", "route", "router", "controller", "handler", "endpoint"] as const;
const PARENT_SUFFIXES = [
  "service",
  "controller",
  "handler",
  "repository",
  "module",
  "router",
  "endpoint",
] as const;

const noopMetrics: QueryExpansionMetrics = {
  incrementQueryExpansions: () => undefined,
  incrementQueryExpansionTerms: () => undefined,
  incrementQueryExpansionCacheHits: () => undefined,
};
const noopLogger: QueryExpansionLogger = { info: () => undefined };

function boundedCount(value: number): number {
  return Math.min(1_000_000, Math.max(0, Math.trunc(value)));
}

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function canonical(value: string): string {
  return words(value).join("");
}

function normalizedTerm(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\s+/g, " ");
}

function fileStem(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const last = normalized.split("/").at(-1) ?? normalized;
  return last.replace(/\.[^.]+$/, "").replace(/^index$/i, normalized.split("/").at(-2) ?? last);
}

function moduleStem(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
  return fileStem(normalized.split("/").at(-1) ?? normalized);
}

function queryKeys(query: string): Set<string> {
  const keys = new Set(words(query).map(canonical));
  const full = canonical(query);
  if (full) keys.add(full);
  return keys;
}

function metadataFingerprint(metadata: QueryExpansionMetadata): string {
  const sort = (values: readonly string[]) => [...values].map(normalizedTerm).sort((a, b) => a.localeCompare(b));
  return JSON.stringify({
    frameworks: sort(metadata.frameworks),
    modules: sort(metadata.modules),
    services: sort(metadata.services),
    apiRoutes: sort(metadata.apiRoutes),
    packages: sort(metadata.packages),
    filenames: sort(metadata.filenames),
    symbols: [...metadata.symbols]
      .map((symbol) => [symbol.name, symbol.filePath, symbol.exported] as const)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    imports: [...metadata.imports]
      .map((entry) => [entry.fromFile, entry.source, [...entry.importedSymbols].sort(), entry.isRelative] as const)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    graphRelations: [...metadata.graphRelations]
      .map((relation) => [relation.from, relation.to, relation.kind] as const)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
}

function deepFreezeResult(result: QueryExpansionResult): QueryExpansionResult {
  for (const term of result.terms) Object.freeze(term);
  Object.freeze(result.terms);
  return Object.freeze(result);
}

function matchesQuery(value: string, keys: ReadonlySet<string>): boolean {
  const valueCanonical = canonical(value);
  if (!valueCanonical) return false;
  if (keys.has(valueCanonical)) return true;
  return words(value).some((word) => keys.has(canonical(word)));
}

function frameworkApiAliases(frameworks: readonly string[]): string[] {
  const known = new Set(frameworks.flatMap(words));
  if (["express", "fastify", "hono", "koa", "nest", "nestjs"].some((name) => known.has(name))) {
    return ["route", "handler", "endpoint", "controller"];
  }
  if (["next", "nextjs", "remix", "astro"].some((name) => known.has(name))) {
    return ["route", "handler", "endpoint"];
  }
  return [];
}

export function expandRepositoryQuery(input: QueryExpansionInput): QueryExpansionResult {
  if (!Number.isInteger(input.maxTerms) || input.maxTerms < 0) {
    throw new TypeError("maxTerms must be a non-negative integer");
  }
  if (
    !Number.isFinite(input.expandedScoreMultiplier) ||
    input.expandedScoreMultiplier <= 0 ||
    input.expandedScoreMultiplier > 1
  ) {
    throw new TypeError("expandedScoreMultiplier must be greater than zero and at most one");
  }

  const query = input.query.trim().replace(/\s+/g, " ");
  const keys = queryKeys(query);
  const exclusionKeys = query.split(" ").length === 1
    ? new Set([canonical(query)])
    : new Set(words(query).map(canonical));
  const catalog = new Map<string, string>();
  const exactCatalog = new Map<string, string>();
  const addCatalog = (value: string) => {
    const term = normalizedTerm(value);
    const key = canonical(term);
    if (!term || !key) return;
    if (!catalog.has(key)) catalog.set(key, term);
    if (!exactCatalog.has(term.toLowerCase())) exactCatalog.set(term.toLowerCase(), term);
  };
  for (const value of [
    ...input.metadata.modules,
    ...input.metadata.services,
    ...input.metadata.apiRoutes,
    ...input.metadata.packages,
    ...input.metadata.filenames.map(fileStem),
    ...input.metadata.symbols.map((symbol) => symbol.name),
  ]) addCatalog(value);

  const proposals = new Map<string, { term: string; source: QueryExpansionSource }>();
  const propose = (value: string, source: QueryExpansionSource) => {
    const term = normalizedTerm(value);
    const key = canonical(term);
    const proposalKey = term.toLowerCase();
    if (!term || !key || exclusionKeys.has(key) || proposals.has(proposalKey)) return;
    proposals.set(proposalKey, { term, source });
  };

  for (const family of SYMBOL_ALIAS_FAMILIES) {
    if (!family.some((alias) => keys.has(canonical(alias)))) continue;
    for (const alias of family) {
      const existing = exactCatalog.get(alias.toLowerCase()) ?? catalog.get(canonical(alias));
      if (existing) propose(existing, "symbol_alias");
    }
  }

  for (const family of MODULE_ALIAS_FAMILIES) {
    if (!family.some((alias) => keys.has(canonical(alias)))) continue;
    for (const alias of family) {
      const existing = catalog.get(canonical(alias));
      if (existing) propose(existing, "module_alias");
    }
  }

  const apiQuery = API_ALIASES.some((alias) => keys.has(canonical(alias)));
  if (apiQuery) {
    for (const alias of frameworkApiAliases(input.metadata.frameworks)) {
      propose(alias, "framework_alias");
    }
    for (const route of input.metadata.apiRoutes) propose(route, "api_alias");
  }

  for (const entry of input.metadata.imports) {
    const fromMatches = matchesQuery(fileStem(entry.fromFile), keys) ||
      input.metadata.symbols.some((symbol) =>
        symbol.filePath === entry.fromFile && matchesQuery(symbol.name, keys)
      );
    const targetMatches = matchesQuery(moduleStem(entry.source), keys) ||
      entry.importedSymbols.some((symbol) => matchesQuery(symbol, keys));
    if (fromMatches) {
      propose(moduleStem(entry.source), entry.isRelative ? "import_relationship" : "package_metadata");
      for (const symbol of entry.importedSymbols) propose(symbol, "import_relationship");
    }
    if (targetMatches) propose(fileStem(entry.fromFile), "import_relationship");
  }

  for (const relation of input.metadata.graphRelations) {
    const source = relation.kind === "imports" ? "import_relationship" : "graph_relationship";
    if (matchesQuery(relation.from, keys)) propose(relation.to, source);
    if (matchesQuery(relation.to, keys)) propose(relation.from, source);
  }

  const matchedSymbols = input.metadata.symbols.filter((symbol) => matchesQuery(symbol.name, keys));
  for (const symbol of matchedSymbols) {
    const symbolWords = words(symbol.name);
    const suffix = PARENT_SUFFIXES.find((candidate) => symbolWords.at(-1) === candidate);
    if (suffix && symbolWords.length > 1) {
      const base = symbolWords.slice(0, -1).join("-");
      propose(base, "parent_module");
      propose(`${base}s`, "parent_module");
      propose(`${base}-module`, "parent_module");
    }
  }

  for (const value of [...input.metadata.modules, ...input.metadata.services]) {
    if (matchesQuery(value, keys)) propose(value, "repository_summary");
  }
  for (const symbol of input.metadata.symbols) {
    if (symbol.exported && matchesQuery(symbol.name, keys)) propose(symbol.name, "exported_symbol");
  }
  for (const filename of input.metadata.filenames) {
    const stem = fileStem(filename);
    if (matchesQuery(stem, keys)) propose(stem, "filename");
  }
  for (const packageName of input.metadata.packages) {
    if (matchesQuery(packageName, keys)) propose(packageName, "package_metadata");
  }

  const sourceRank = new Map(SOURCE_ORDER.map((source, index) => [source, index]));
  const terms: QueryExpansionTerm[] = [...proposals.values()]
    .sort((left, right) =>
      (sourceRank.get(left.source) ?? SOURCE_ORDER.length) -
        (sourceRank.get(right.source) ?? SOURCE_ORDER.length) ||
      left.term.localeCompare(right.term)
    )
    .slice(0, input.maxTerms)
    .map((proposal) => ({
      ...proposal,
      scoreMultiplier: input.expandedScoreMultiplier,
    }));

  return deepFreezeResult({
    primaryQuery: query,
    expandedQuery: terms.map((term) => term.term).join(" "),
    terms,
    repositoryVersion: input.repositoryVersion,
    expandedScoreMultiplier: input.expandedScoreMultiplier,
  });
}

export interface QueryExpansionServiceOptions {
  metrics?: QueryExpansionMetrics;
  logger?: QueryExpansionLogger;
  maxCacheEntries?: number;
}

export class QueryExpansionService {
  private readonly metrics: QueryExpansionMetrics;
  private readonly logger: QueryExpansionLogger;
  private readonly maxCacheEntries: number;
  private readonly cache = new Map<string, QueryExpansionResult>();

  constructor(options: QueryExpansionServiceOptions = {}) {
    this.metrics = options.metrics ?? noopMetrics;
    this.logger = options.logger ?? noopLogger;
    this.maxCacheEntries = options.maxCacheEntries ?? 500;
    if (!Number.isInteger(this.maxCacheEntries) || this.maxCacheEntries <= 0) {
      throw new TypeError("maxCacheEntries must be a positive integer");
    }
  }

  expand(input: QueryExpansionInput): QueryExpansionResult {
    this.logger.info("query_expansion_started", {
      repositoryCount: input.repositoryId.trim() ? 1 : 0,
      maxTerms: input.maxTerms,
      metadataSymbolCount: boundedCount(input.metadata.symbols.length),
      metadataImportCount: boundedCount(input.metadata.imports.length),
    });
    const key = JSON.stringify([
      input.repositoryId,
      input.repositoryVersion,
      input.query.trim().replace(/\s+/g, " ").toLowerCase(),
      input.maxTerms,
      input.expandedScoreMultiplier,
      createHash("sha256").update(metadataFingerprint(input.metadata)).digest("hex"),
    ]);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      this.metrics.incrementQueryExpansionCacheHits();
      this.logger.info("query_expansion_cache_hit", {
        termCount: cached.terms.length,
        repositoryCount: input.repositoryId.trim() ? 1 : 0,
      });
      return cached;
    }

    const result = expandRepositoryQuery(input);
    this.metrics.incrementQueryExpansions();
    this.metrics.incrementQueryExpansionTerms(result.terms.length);
    this.logger.info("query_expansion_completed", {
      termCount: result.terms.length,
      metadataSymbolCount: boundedCount(input.metadata.symbols.length),
      metadataImportCount: boundedCount(input.metadata.imports.length),
    });
    this.cache.set(key, result);
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
    return result;
  }

  clear(): void {
    this.cache.clear();
  }
}
