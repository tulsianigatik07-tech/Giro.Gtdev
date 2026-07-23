import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import type { PublishedRepositoryArtifacts } from "../services/repository/artifacts/repositoryArtifactStore.js";
import { pathSearch } from "../services/retrieval/pathSearch.js";
import {
  executeHybridRetrievalV2,
} from "../services/retrieval/hybridV2/pipeline.js";
import {
  normalizeRetrievalWeights,
  validateHybridRetrievalV2Config,
} from "../services/retrieval/hybridV2/config.js";
import {
  DeterministicNoopCrossEncoder,
  OpenAICrossEncoder,
  rerankWithFallback,
  type CrossEncoder,
} from "../services/retrieval/hybridV2/crossEncoder.js";
import type {
  HybridRetrievalV2Config,
  SourceCandidate,
} from "../services/retrieval/hybridV2/types.js";
import type { RetrievalResult } from "../services/retrieval/types.js";

const REPOSITORY = "acme/widgets";
const REVISION = "revision-1";

const CONFIG: HybridRetrievalV2Config = {
  weights: normalizeRetrievalWeights({
    semanticSimilarity: 1,
    lexicalSimilarity: 1,
    symbolMatch: 1,
    pathSimilarity: 1,
    fileImportance: 1,
    repositoryImportance: 1,
    dependencyGraphImportance: 1,
    freshness: 1,
    revisionMatch: 1,
  }),
  maxChunks: 20,
  maxFiles: 20,
  maxSymbols: 20,
  maxTokens: 10_000,
  maxPerFile: 2,
  rerankerWeight: 0.25,
  rerankerProvider: "deterministic",
  rerankerModel: "test",
};

function result(id: string, overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    repository: REPOSITORY,
    filePath: `src/${id}.ts`,
    language: "typescript",
    content: `export function ${id}() { return "${id}"; }`,
    startLine: 1,
    endLine: 3,
    score: 0.8,
    source: "semantic",
    signals: { semantic: 0.8 },
    chunkId: id,
    ...overrides,
  };
}

function source(
  sourceName: SourceCandidate["source"],
  id: string,
  overrides: Partial<RetrievalResult> = {},
): SourceCandidate {
  return { source: sourceName, result: result(id, overrides) };
}

async function pipeline(
  candidates: SourceCandidate[],
  config: HybridRetrievalV2Config = CONFIG,
  crossEncoder: CrossEncoder = new DeterministicNoopCrossEncoder(),
  artifacts: PublishedRepositoryArtifacts | null = null,
) {
  return executeHybridRetrievalV2({
    query: "widget service",
    repositoryId: REPOSITORY,
    repositoryRevision: REVISION,
    candidates,
    artifacts,
    limit: 20,
  }, { config, crossEncoder });
}

test("lexical and semantic retrieval remain independently weighted", async () => {
  const semanticOnly = { ...CONFIG, weights: normalizeRetrievalWeights({
    semanticSimilarity: 1, lexicalSimilarity: 0, symbolMatch: 0, pathSimilarity: 0,
    fileImportance: 0, repositoryImportance: 0, dependencyGraphImportance: 0,
    freshness: 0, revisionMatch: 0,
  }) };
  const output = await pipeline([
    source("lexical", "lexical", { score: 1 }),
    source("semantic", "semantic", { score: 0.5 }),
  ], semanticOnly);
  assert.equal(output.results[0]?.chunkId, "semantic");
  assert.equal(output.diagnostics.candidateCounts.lexical, 1);
  assert.equal(output.diagnostics.candidateCounts.semantic, 1);
});

test("all Stage 1 sources merge into one duplicate-free candidate", async () => {
  const shared = result("shared", { score: 0.9 });
  const output = await pipeline([
    { source: "lexical", result: shared },
    { source: "semantic", result: shared },
    { source: "symbol", result: shared },
    { source: "path", result: shared },
  ]);
  assert.equal(output.results.length, 1);
  assert.deepEqual(output.diagnostics.candidates[0]?.retrievalSources, [
    "lexical", "path", "semantic", "symbol",
  ]);
  assert.equal(output.diagnostics.discardedCandidates.filter(
    (item) => item.reason === "duplicate_chunk",
  ).length, 3);
});

test("cross-encoder reranking is deterministic and can change final order", async () => {
  const reranker: CrossEncoder = {
    name: "test",
    verify: () => undefined,
    rerank: async ({ candidates }) => new Map(candidates.map((candidate) => [
      candidate.result.chunkId!,
      candidate.result.chunkId === "second" ? 1 : 0,
    ])),
  };
  const config = { ...CONFIG, rerankerWeight: 1 };
  const first = await pipeline([
    source("semantic", "first", { score: 1 }),
    source("semantic", "second", { score: 0.2 }),
  ], config, reranker);
  const second = await pipeline([
    source("semantic", "first", { score: 1 }),
    source("semantic", "second", { score: 0.2 }),
  ], config, reranker);
  assert.deepEqual(first.results.map((item) => item.chunkId), ["second", "first"]);
  assert.deepEqual(second.results, first.results);
  assert.equal(first.diagnostics.candidates[0]?.rerankerScore, 1);
});

test("OpenAI cross-encoder validates complete scores and unavailable rerankers fall back", async () => {
  const encoder = new OpenAICrossEncoder({
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify({
            scores: [{ id: "a", score: 0.75 }],
          }) } }],
        }),
      },
    },
  } as never, "test-reranker");
  const candidateOutput = await pipeline([source("semantic", "a")]);
  const candidate = {
    result: candidateOutput.results[0]!,
    sources: new Set(["semantic" as const]),
    signals: {
      semanticSimilarity: 0.8, lexicalSimilarity: 0, symbolMatch: 0,
      pathSimilarity: 0, fileImportance: 0, repositoryImportance: 0,
      dependencyGraphImportance: 0, freshness: 0, revisionMatch: 0,
    },
    structural: {
      repositoryDepth: 0, dependencyImportance: 0, exportedPublicSymbols: 0,
      referenceCount: 0, fileCentrality: 0, recentlyIndexedRevision: 0,
      generatedFilePenalty: 0, vendorDependencyPenalty: 0,
    },
    expansionMultiplier: 1,
    baseScore: 0.8,
    rerankerScore: 0,
    finalScore: 0.8,
    originalRank: 0,
  };
  assert.equal((await encoder.rerank({
    query: "widget",
    candidates: [candidate],
  })).get("a"), 0.75);
  const fallback = await rerankWithFallback({
    name: "unavailable-local",
    verify: () => undefined,
    rerank: async () => { throw new Error("offline"); },
  }, { query: "widget", candidates: [candidate] });
  assert.equal(fallback.get("a"), candidate.baseScore);
});

test("content duplicates and repeated symbols are eliminated", async () => {
  const duplicateContent = "export const identical = true;";
  const output = await pipeline([
    source("semantic", "a", { content: duplicateContent, symbol: "alpha" }),
    source("lexical", "b", { content: duplicateContent, symbol: "beta" }),
    source("symbol", "c", { content: "other content", symbol: "alpha" }),
  ]);
  assert.equal(output.results.length, 1);
  assert.ok(output.diagnostics.discardedCandidates.some(
    (item) => item.reason === "duplicate_content",
  ));
  assert.ok(output.diagnostics.discardedCandidates.some(
    (item) => item.reason === "repeated_symbol",
  ));
});

test("diversity prevents one file from dominating while preserving rank order", async () => {
  const config = { ...CONFIG, maxPerFile: 1 };
  const output = await pipeline([
    source("semantic", "a1", { filePath: "src/a.ts", score: 1 }),
    source("semantic", "a2", { filePath: "src/a.ts", score: 0.9 }),
    source("semantic", "b1", { filePath: "src/b.ts", score: 0.8 }),
  ], config);
  assert.deepEqual(output.results.map((item) => item.chunkId), ["a1", "b1"]);
  assert.ok(output.diagnostics.discardedCandidates.some(
    (item) => item.reason === "same_file_limit",
  ));
});

test("budget optimizer enforces chunk, file, symbol, and token maximums", async () => {
  const config = {
    ...CONFIG,
    maxChunks: 2,
    maxFiles: 2,
    maxSymbols: 1,
    maxTokens: 20,
  };
  const output = await pipeline([
    source("semantic", "a", { content: "a".repeat(40), symbol: "A" }),
    source("semantic", "b", { content: "b".repeat(40), symbol: "B" }),
    source("semantic", "c", { content: "c".repeat(100), symbol: "C" }),
  ], config);
  assert.equal(output.results.length, 1);
  assert.ok(output.diagnostics.tokenUsage.used <= config.maxTokens);
  assert.ok(output.diagnostics.discardedCandidates.some(
    (item) => item.reason === "symbol_limit" || item.reason === "token_budget",
  ));
});

test("weight configuration normalizes and rejects invalid totals", () => {
  const weights = normalizeRetrievalWeights({
    semanticSimilarity: 2, lexicalSimilarity: 1, symbolMatch: 0, pathSimilarity: 0,
    fileImportance: 0, repositoryImportance: 0, dependencyGraphImportance: 0,
    freshness: 0, revisionMatch: 0,
  });
  assert.equal(weights.semanticSimilarity, 2 / 3);
  assert.equal(weights.lexicalSimilarity, 1 / 3);
  assert.throws(() => normalizeRetrievalWeights({
    semanticSimilarity: 0, lexicalSimilarity: 0, symbolMatch: 0, pathSimilarity: 0,
    fileImportance: 0, repositoryImportance: 0, dependencyGraphImportance: 0,
    freshness: 0, revisionMatch: 0,
  }));
  assert.throws(() => validateHybridRetrievalV2Config({ ...CONFIG, maxTokens: 0 }));
});

test("diagnostics are internal, bounded metadata and results contain no diagnostics", async () => {
  const output = await pipeline([source("semantic", "a")]);
  assert.equal("diagnostics" in output.results[0]!, false);
  assert.deepEqual(Object.keys(output.diagnostics.tokenUsage).sort(), ["maximum", "used"]);
  assert.equal(JSON.stringify(output.diagnostics).includes(output.results[0]!.content), false);
});

test("repository ownership isolation drops candidates from other repositories", async () => {
  const output = await pipeline([
    source("semantic", "owned"),
    source("semantic", "foreign", { repository: "other/private" }),
  ]);
  assert.deepEqual(output.results.map((item) => item.chunkId), ["owned"]);
});

test("structural scoring only accepts artifacts for the requested published revision", async () => {
  const artifacts = {
    repositoryId: REPOSITORY,
    repositoryRevision: "stale-revision",
    graph: { repositoryId: REPOSITORY, repositoryVersion: "stale-revision", nodes: [], edges: [] },
    summary: {
      repositoryId: REPOSITORY,
      repositoryVersion: "stale-revision",
      generatedAt: "2026-01-01T00:00:00.000Z",
      purpose: "",
      languages: [], frameworks: [], packageManagers: [], applications: [], libraries: [],
      services: [], modules: [], entrypoints: [], importantDirectories: [], configFiles: [],
      apiSurface: [], backgroundWorkers: [], dataStores: [], authentication: [], retrieval: [],
      indexing: [], testing: [], build: [], deployment: [],
      dependencyOverview: {
        totalNodes: 0, totalEdges: 0, averageInDegree: 0, averageOutDegree: 0,
        centralModules: [], dependencyHotspots: [], isolatedModules: [], circularDependencies: [],
      },
    },
    fileSnapshot: { files: [], updatedAt: "2026-01-01T00:00:00.000Z" },
    symbolIndex: [],
    graphSource: [],
  } as PublishedRepositoryArtifacts;
  const output = await pipeline([source("semantic", "a")], CONFIG, new DeterministicNoopCrossEncoder(), artifacts);
  assert.equal(output.results[0]?.signals.graph, 0);
});

test("path retrieval requires revision and filters by published embedding compatibility", async () => {
  await assert.rejects(() => pathSearch("widget", "acme", "widgets", 5), /Published repository revision/);
  const equalityFilters: Array<[string, unknown]> = [];
  const rows = [{
    id: "path-1",
    repository: REPOSITORY,
    file_path: "src/widget/service.ts",
    language: "typescript",
    content: "export const service = true;",
    start_line: 1,
    end_line: 1,
  }];
  const query = {
    select: () => query,
    eq: (column: string, value: unknown) => {
      equalityFilters.push([column, value]);
      return query;
    },
    or: () => query,
    limit: () => query,
    abortSignal: async () => ({ data: rows, error: null }),
  };
  const results = await pathSearch("widget service", "acme", "widgets", 5, {
    repositoryVersion: REVISION,
    databaseClient: { from: () => query } as never,
  });
  assert.equal(results[0]?.chunkId, "path-1");
  assert.ok(equalityFilters.some(([column, value]) =>
    column === "repository_revision" && value === REVISION));
  assert.ok(equalityFilters.some(([column, value]) =>
    column === "embedding_version" && typeof value === "string"));
});

test("memory and database candidate ordering produce equivalent deterministic output", async () => {
  const memory = [
    source("semantic", "a", { score: 0.9 }),
    source("lexical", "b", { score: 0.8 }),
    source("path", "c", { score: 0.7 }),
  ];
  const database = [...memory].reverse();
  const [left, right] = await Promise.all([pipeline(memory), pipeline(database)]);
  assert.deepEqual(right.results, left.results);
  assert.deepEqual(right.diagnostics.candidateCounts, left.diagnostics.candidateCounts);
});

test("backend startup validates retrieval configuration and reranker availability before serving", async () => {
  const startup = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const validation = startup.indexOf("validateHybridRetrievalV2Config");
  const reranker = startup.indexOf("runtimeCrossEncoder.verify");
  const serving = startup.indexOf("server = serve");
  assert.ok(validation >= 0 && validation < serving);
  assert.ok(reranker >= 0 && reranker < serving);
});
