import assert from "node:assert/strict";
import { test } from "node:test";

import { MetricsRegistry } from "../observability/metrics.js";
import { RetrievalCache } from "../services/retrieval/cache/retrievalCache.js";
import { applyQueryExpansionPenalty, hybridSearch } from "../services/retrieval/hybridSearch.js";
import {
  QueryExpansionService,
  expandRepositoryQuery,
} from "../services/retrieval/queryExpansion/queryExpansion.js";
import type {
  QueryExpansionInput,
  QueryExpansionMetadata,
} from "../services/retrieval/queryExpansion/queryExpansionTypes.js";
import { getRuntimeQueryExpansionMetadata } from "../services/retrieval/queryExpansion/runtimeQueryExpansion.js";
import {
  clearGraphSourceStore,
  setFileSymbolMap,
} from "../services/repository/graphSourceStore.js";
import {
  clearRepositorySymbols,
  saveRepositorySymbols,
} from "../services/repository/symbolIndexStore.js";
import {
  clearRepositorySymbolGraphs,
  saveRepositorySymbolGraph,
} from "../services/repositoryGraph/runtimeRepositoryGraph.js";

type LogEntry = { event: string; fields?: Record<string, unknown> };

const metadata: QueryExpansionMetadata = {
  frameworks: ["hono"],
  modules: ["payments", "billing", "invoice", "checkout"],
  services: ["UserService"],
  apiRoutes: ["createPayment", "paymentStatus"],
  packages: ["@acme/auth", "stripe"],
  filenames: ["src/services/userService.ts", "src/payments/checkout.ts"],
  symbols: [
    { name: "UserService", filePath: "src/services/userService.ts", exported: true },
    { name: "login", filePath: "src/auth/login.ts", exported: true },
    { name: "authenticate", filePath: "src/auth/authenticate.ts", exported: true },
    { name: "auth", filePath: "src/auth/auth.ts", exported: true },
    { name: "signin", filePath: "src/auth/signin.ts", exported: true },
    { name: "sign_in", filePath: "src/auth/sign_in.ts", exported: true },
  ],
  imports: [
    {
      fromFile: "src/services/userService.ts",
      source: "../repositories/userRepository",
      importedSymbols: ["UserRepository"],
      isRelative: true,
    },
    {
      fromFile: "src/auth/login.ts",
      source: "@acme/auth",
      importedSymbols: ["verifyToken"],
      isRelative: false,
    },
  ],
  graphRelations: [
    { from: "UserService", to: "UserRepository", kind: "imports" },
  ],
};

function input(overrides: Partial<QueryExpansionInput> = {}): QueryExpansionInput {
  return {
    repositoryId: "acme/widgets",
    repositoryVersion: "v1",
    query: "login",
    metadata,
    maxTerms: 8,
    expandedScoreMultiplier: 0.85,
    ...overrides,
  };
}

test("query expansion is deterministic and does not mutate indexed metadata", () => {
  const before = structuredClone(metadata);
  const first = expandRepositoryQuery(input());
  const second = expandRepositoryQuery(input());

  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.deepEqual(metadata, before);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.terms), true);
});

test("symbol aliases expand only aliases present in repository metadata", () => {
  const result = expandRepositoryQuery(input());
  const symbolAliases = result.terms
    .filter((term) => term.source === "symbol_alias")
    .map((term) => term.term);

  assert.deepEqual(symbolAliases, ["auth", "authenticate", "sign_in", "signin"]);
  assert.equal(symbolAliases.includes("authentication"), false);
});

test("module relationships expand payment vocabulary present in metadata", () => {
  const result = expandRepositoryQuery(input({ query: "payment" }));
  assert.deepEqual(
    result.terms.filter((term) => term.source === "module_alias").map((term) => term.term),
    ["billing", "checkout", "invoice", "payments"],
  );
});

test("summary, exported-symbol, filename, and package metadata contribute terms", () => {
  const focusedMetadata: QueryExpansionMetadata = {
    frameworks: [],
    modules: ["PaymentService"],
    services: [],
    apiRoutes: [],
    packages: ["stripe"],
    filenames: ["src/payments/paymentGateway.ts"],
    symbols: [{ name: "PaymentProcessor", filePath: "src/payments/processor.ts", exported: true }],
    imports: [{
      fromFile: "src/payments/paymentGateway.ts",
      source: "stripe",
      importedSymbols: ["StripeClient"],
      isRelative: false,
    }],
    graphRelations: [],
  };
  const result = expandRepositoryQuery(input({
    query: "payment",
    metadata: focusedMetadata,
    maxTerms: 10,
  }));
  const sources = new Set(result.terms.map((term) => term.source));

  assert.equal(sources.has("repository_summary"), true);
  assert.equal(sources.has("exported_symbol"), true);
  assert.equal(sources.has("filename"), true);
  assert.equal(sources.has("package_metadata"), true);
});

test("framework and API aliases are derived from indexed framework and API metadata", () => {
  const result = expandRepositoryQuery(input({ query: "controller" }));
  assert.deepEqual(
    result.terms.filter((term) => term.source === "framework_alias").map((term) => term.term),
    ["endpoint", "handler", "route"],
  );
  assert.deepEqual(
    result.terms.filter((term) => term.source === "api_alias").map((term) => term.term),
    ["createPayment", "paymentStatus"],
  );
});

test("one-hop imports and parent modules produce bounded related terms", () => {
  const result = expandRepositoryQuery(input({ query: "UserService" }));
  const related = result.terms.map((term) => [term.term, term.source]);

  assert.equal(related.some(([term, source]) => term === "userRepository" && source === "import_relationship"), true);
  assert.equal(related.some(([term, source]) => term === "user" && source === "parent_module"), true);
  assert.equal(related.some(([term, source]) => term === "users" && source === "parent_module"), true);
  assert.equal(related.some(([term, source]) => term === "user-module" && source === "parent_module"), true);
});

test("maximum term limit is exact and expansion never recurses", () => {
  const result = expandRepositoryQuery(input({ query: "UserService", maxTerms: 3 }));
  assert.equal(result.terms.length, 3);
  assert.equal(result.expandedQuery.split(" ").length, 3);
  assert.equal(result.terms.every((term) => term.scoreMultiplier === 0.85), true);
});

test("expanded retrieval scores and signals receive the configured penalty", () => {
  const [penalized] = applyQueryExpansionPenalty([{
    repository: "acme/widgets",
    filePath: "src/auth.ts",
    language: "typescript",
    content: "auth",
    startLine: 1,
    endLine: 1,
    score: 1,
    source: "keyword",
    signals: { keyword: 1, graph: 0.5 },
  }], 0.85);

  assert.equal(penalized?.score, 0.85);
  assert.equal(penalized?.signals.keyword, 0.85);
  assert.equal(penalized?.signals.graph, 0.425);
});

test("expansion cache is version-aware and emits safe metrics and logs", () => {
  const metrics = new MetricsRegistry();
  const logs: LogEntry[] = [];
  const service = new QueryExpansionService({
    metrics,
    logger: { info: (event, fields) => logs.push({ event, fields }) },
  });
  const secretQuery = "login private-customer-name";
  const request = input({ query: secretQuery });

  service.expand(request);
  service.expand(request);
  service.expand({ ...request, repositoryVersion: "v2" });

  const output = metrics.render();
  assert.match(output, /giro_query_expansions_total 2/);
  assert.match(output, /giro_query_expansion_terms_total \d+/);
  assert.match(output, /giro_query_expansion_cache_hits_total 1/);
  assert.deepEqual(logs.map((entry) => entry.event), [
    "query_expansion_started",
    "query_expansion_completed",
    "query_expansion_started",
    "query_expansion_cache_hit",
    "query_expansion_started",
    "query_expansion_completed",
  ]);
  assert.equal(JSON.stringify(logs).includes(secretQuery), false);
  assert.equal(JSON.stringify(logs).includes("src/"), false);
});

test("expanded terms participate in retrieval cache keys and version invalidation", async () => {
  let version = "v1";
  const metrics = new MetricsRegistry();
  const cache = new RetrievalCache({
    ttlMs: 10_000,
    maxEntries: 10,
    metrics,
    logger: { info: () => undefined },
    versionProvider: () => version,
  });
  let loads = 0;
  const load = async () => ({ load: ++loads });
  const baseKey = {
    repositoryId: "acme/widgets",
    query: "login",
    mode: "hybrid",
  };

  await cache.getOrLoad({ ...baseKey, options: { expansionTerms: ["auth"] } }, load);
  await cache.getOrLoad({ ...baseKey, options: { expansionTerms: ["auth"] } }, load);
  await cache.getOrLoad({ ...baseKey, options: { expansionTerms: ["signin"] } }, load);
  version = "v2";
  await cache.getOrLoad({ ...baseKey, options: { expansionTerms: ["auth"] } }, load);
  assert.equal(loads, 3);
});

test("runtime expansion reads current indexed metadata without rescanning files", () => {
  const repositoryId = "acme/runtime-expansion";
  clearGraphSourceStore();
  clearRepositorySymbols();
  clearRepositorySymbolGraphs();
  try {
    setFileSymbolMap(repositoryId, {
      filePath: "src/auth/login.ts",
      language: "typescript",
      symbols: [{ name: "login", kind: "function", exported: true, line: 1 }],
      imports: [{
        source: "@acme/auth-core",
        specifiers: ["verifyToken"],
        isRelative: false,
      }],
    });
    saveRepositorySymbols(repositoryId, [{
      filePath: "src/auth/login.ts",
      symbolName: "login",
      kind: "function",
      startLine: 1,
      endLine: 1,
    }]);
    saveRepositorySymbolGraph({
      repositoryId,
      repositoryVersion: "job-1:1",
      nodes: [{
        symbolId: "login",
        repositoryId,
        name: "login",
        kind: "function",
        language: "typescript",
        file: "src/auth/login.ts",
        line: 1,
        repositoryVersion: "job-1:1",
      }],
      edges: [],
    });

    const current = getRuntimeQueryExpansionMetadata(
      repositoryId,
      "job-1:1:completed:completed:100",
    );
    assert.deepEqual(current.packages, ["@acme/auth-core"]);
    assert.equal(current.symbols[0]?.exported, true);
    assert.equal(current.imports[0]?.importedSymbols[0], "verifyToken");

    const stale = getRuntimeQueryExpansionMetadata(repositoryId, "job-2:1:queued:queued:0");
    assert.deepEqual(stale.symbols, []);
    assert.deepEqual(stale.imports, []);
  } finally {
    clearGraphSourceStore();
    clearRepositorySymbols();
    clearRepositorySymbolGraphs();
  }
});

test("hybrid retrieval response contract is unchanged when expansion is enabled", async () => {
  const metrics = new MetricsRegistry();
  const cache = new RetrievalCache({
    ttlMs: 10_000,
    maxEntries: 10,
    metrics,
    logger: { info: () => undefined },
  });
  const response = await hybridSearch(
    { query: "login", owner: "acme", repo: "widgets", limit: 5 },
    {
      cache,
      execute: async (request) => ({
        query: request.query,
        repository: `${request.owner}/${request.repo}`,
        results: [],
        citations: [],
        stats: {
          semanticResults: 0,
          keywordResults: 0,
          symbolResults: 0,
          graphBoosted: 0,
          returned: 0,
        },
      }),
    },
  );

  assert.deepEqual(Object.keys(response).sort(), ["citations", "query", "repository", "results", "stats"]);
  assert.deepEqual(Object.keys(response.stats).sort(), [
    "graphBoosted",
    "keywordResults",
    "returned",
    "semanticResults",
    "symbolResults",
  ]);
});
