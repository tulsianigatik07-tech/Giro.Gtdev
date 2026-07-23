import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PublishedRepositoryArtifacts } from "../../services/repository/artifacts/repositoryArtifactStore.js";
import type { SourceCandidate } from "../../services/retrieval/hybridV2/types.js";
import type { RetrievalResult } from "../../services/retrieval/types.js";
import {
  RepositoryFixtureSuiteSchema,
  RetrievalBenchmarkSuiteSchema,
  type FixtureEmbedding,
  type RepositoryFixture,
  type RepositoryFixtureSuite,
  type RetrievalBenchmarkSuite,
} from "./schema.js";

export const DEFAULT_BENCHMARK_PATH = path.resolve(
  "evaluation/retrieval/benchmarks.json",
);
export const DEFAULT_FIXTURE_PATH = path.resolve(
  "evaluation/retrieval/repository-fixtures.json",
);

export class EvaluationFixtureCompatibilityError extends Error {
  constructor(
    readonly reason:
      | "revision_not_found"
      | "revision_not_published"
      | "embedding_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "EvaluationFixtureCompatibilityError";
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

export async function loadBenchmarkSuite(
  filePath = DEFAULT_BENCHMARK_PATH,
): Promise<RetrievalBenchmarkSuite> {
  return RetrievalBenchmarkSuiteSchema.parse(await readJson(filePath));
}

export async function loadRepositoryFixtureSuite(
  filePath = DEFAULT_FIXTURE_PATH,
): Promise<RepositoryFixtureSuite> {
  return RepositoryFixtureSuiteSchema.parse(await readJson(filePath));
}

export function requirePublishedFixture(
  suite: RepositoryFixtureSuite,
  fixtureId: string,
  repositoryRevision: string,
  expectedEmbedding?: Partial<FixtureEmbedding>,
): RepositoryFixture {
  const fixture = suite.fixtures.find((candidate) =>
    candidate.fixtureId === fixtureId &&
    candidate.repositoryRevision === repositoryRevision);
  if (!fixture) {
    throw new EvaluationFixtureCompatibilityError(
      "revision_not_found",
      `Fixture revision ${fixtureId}@${repositoryRevision} was not found.`,
    );
  }
  if (fixture.publicationStatus !== "published") {
    throw new EvaluationFixtureCompatibilityError(
      "revision_not_published",
      `Fixture revision ${fixtureId}@${repositoryRevision} is not published.`,
    );
  }
  for (const key of [
    "provider",
    "model",
    "dimension",
    "embeddingVersion",
    "chunkingStrategyVersion",
  ] as const) {
    const expected = expectedEmbedding?.[key];
    if (expected !== undefined && fixture.embedding[key] !== expected) {
      throw new EvaluationFixtureCompatibilityError(
        "embedding_mismatch",
        `Fixture embedding ${key} is incompatible.`,
      );
    }
  }
  return fixture;
}

export function tokenizeEvaluationText(value: string): string[] {
  return [...new Set(value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/gu)
    .filter((token) => token.length >= 2))]
    .sort();
}

const SEMANTIC_EQUIVALENTS: Readonly<Record<string, readonly string[]>> = {
  amount: ["price", "total", "calculation"],
  basket: ["cart"],
  baskets: ["cart"],
  stale: ["expired"],
  purchasing: ["purchase", "checkout"],
  dispatch: ["routing", "resolver"],
  incoming: ["entrypoint", "request"],
  settings: ["configuration", "config"],
  configured: ["configuration", "config"],
  failure: ["error", "debug"],
  failures: ["error", "debug"],
  risk: ["fraud"],
  latest: ["revision", "change"],
};

function expandedSemanticTokens(query: string): Set<string> {
  const tokens = tokenizeEvaluationText(query);
  return new Set(tokens.flatMap((token) => [
    token,
    ...(SEMANTIC_EQUIVALENTS[token] ?? []),
  ]));
}

function lexicalScores(
  fixture: RepositoryFixture,
  query: string,
): Map<string, number> {
  const terms = tokenizeEvaluationText(query);
  const chunks = fixture.files.flatMap((file) =>
    file.chunks.map((chunk) => ({ file, chunk })));
  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    documentFrequency.set(term, chunks.filter(({ file, chunk }) =>
      tokenizeEvaluationText(`${file.filePath} ${chunk.content}`).includes(term)).length);
  }
  const raw = chunks.map(({ file, chunk }) => {
    const tokens = tokenizeEvaluationText(`${file.filePath} ${chunk.content}`);
    const score = terms.reduce((total, term) => {
      const frequency = tokens.filter((token) => token === term).length;
      const inverseDocumentFrequency = Math.log(
        1 + (chunks.length + 1) / ((documentFrequency.get(term) ?? 0) + 1),
      );
      return total + frequency * inverseDocumentFrequency;
    }, 0);
    return [chunk.chunkId, score] as const;
  });
  const maximum = Math.max(0, ...raw.map(([, score]) => score));
  return new Map(raw.map(([id, score]) => [id, maximum > 0 ? score / maximum : 0]));
}

function overlapScore(left: ReadonlySet<string>, right: readonly string[]): number {
  if (left.size === 0 || right.length === 0) return 0;
  const matches = new Set(right.filter((token) => left.has(token))).size;
  return matches / Math.sqrt(left.size * new Set(right).size);
}

function retrievalResult(
  fixture: RepositoryFixture,
  file: RepositoryFixture["files"][number],
  chunk: RepositoryFixture["files"][number]["chunks"][number],
  source: RetrievalResult["source"],
  score: number,
): RetrievalResult {
  return {
    repository: fixture.repositoryId,
    filePath: file.filePath,
    language: file.language,
    content: chunk.content,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    score,
    source,
    signals: source === "semantic"
      ? { semantic: score }
      : source === "symbol"
        ? { symbol: score }
        : { keyword: score },
    chunkId: chunk.chunkId,
    symbol: chunk.symbols[0],
  };
}

export function generateOfflineCandidates(
  fixture: RepositoryFixture,
  query: string,
): SourceCandidate[] {
  const lexical = lexicalScores(fixture, query);
  const queryTokens = new Set(tokenizeEvaluationText(query));
  const semanticTokens = expandedSemanticTokens(query);
  const candidates: SourceCandidate[] = [];
  for (const file of [...fixture.files].sort((left, right) =>
    left.filePath.localeCompare(right.filePath))) {
    for (const chunk of [...file.chunks].sort((left, right) =>
      left.chunkId.localeCompare(right.chunkId))) {
      const lexicalScore = lexical.get(chunk.chunkId) ?? 0;
      const semanticTerms = tokenizeEvaluationText(
        `${chunk.semanticTerms.join(" ")} ${chunk.content}`,
      );
      const semanticScore = overlapScore(semanticTokens, semanticTerms);
      const symbolTokens = chunk.symbols.flatMap(tokenizeEvaluationText);
      const symbolScore = overlapScore(queryTokens, symbolTokens);
      const pathScore = overlapScore(queryTokens, tokenizeEvaluationText(file.filePath));
      if (lexicalScore > 0) candidates.push({
        source: "lexical",
        result: retrievalResult(fixture, file, chunk, "keyword", lexicalScore),
      });
      if (semanticScore > 0) candidates.push({
        source: "semantic",
        result: retrievalResult(fixture, file, chunk, "semantic", semanticScore),
      });
      if (symbolScore > 0) candidates.push({
        source: "symbol",
        result: retrievalResult(fixture, file, chunk, "symbol", symbolScore),
      });
      if (pathScore > 0) candidates.push({
        source: "path",
        result: retrievalResult(fixture, file, chunk, "keyword", pathScore),
      });
    }
  }
  return candidates;
}

export function fixtureArtifacts(
  fixture: RepositoryFixture,
): PublishedRepositoryArtifacts {
  const graphVersion = `fixture:${fixture.repositoryId}:${fixture.repositoryRevision}`;
  const nodes = fixture.files.flatMap((file) => file.chunks.flatMap((chunk) =>
    chunk.symbols.map((symbol, index) => {
      const nodeId = `${chunk.chunkId}:${symbol}`;
      return {
      nodeId,
      symbolId: nodeId,
      graphVersion,
      repositoryId: fixture.repositoryId,
      repositoryRevision: fixture.repositoryRevision,
      name: symbol,
      qualifiedName: symbol,
      kind: "exported_member" as const,
      language: file.language,
      file: file.filePath,
      line: chunk.startLine + index,
      endLine: chunk.startLine + index,
      column: 1,
      endColumn: 1,
      exported: true,
      defaultExport: false,
      parserVersion: "fixture-v1",
      metadata: {},
      repositoryVersion: fixture.repositoryRevision,
    };
    })));
  const summaryItems = fixture.files
    .filter((file) => !file.generated && !file.vendor)
    .slice(0, 3)
    .map((file) => ({ name: path.basename(file.filePath), path: file.filePath }));
  const empty: never[] = [];
  return {
    repositoryId: fixture.repositoryId,
    repositoryRevision: fixture.repositoryRevision,
    graph: {
      graphVersion,
      repositoryId: fixture.repositoryId,
      repositoryRevision: fixture.repositoryRevision,
      repositoryVersion: fixture.repositoryRevision,
      parserVersion: "fixture-v1",
      status: "published",
      createdAt: "2026-01-01T00:00:00.000Z",
      publishedAt: "2026-01-01T00:00:00.000Z",
      nodes,
      edges: [],
      diagnostics: {
        parsedFileCount: fixture.files.length,
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
      },
    },
    summary: {
      repositoryId: fixture.repositoryId,
      repositoryVersion: fixture.repositoryRevision,
      generatedAt: "2026-01-01T00:00:00.000Z",
      purpose: "Deterministic offline retrieval fixture",
      languages: [], frameworks: [], packageManagers: [], applications: [], libraries: [],
      services: summaryItems, modules: summaryItems, entrypoints: summaryItems.slice(0, 1),
      importantDirectories: [], configFiles: [], apiSurface: summaryItems,
      backgroundWorkers: [], dataStores: [], authentication: [], retrieval: [],
      indexing: [], testing: [], build: [], deployment: [],
      dependencyOverview: {
        totalNodes: nodes.length,
        totalEdges: 0,
        averageInDegree: 0,
        averageOutDegree: 0,
        centralModules: summaryItems.map((item) => item.path),
        dependencyHotspots: [],
        isolatedModules: [],
        circularDependencies: [],
      },
    },
    fileSnapshot: {
      updatedAt: "2026-01-01T00:00:00.000Z",
      files: fixture.files.map((file) => ({
        filePath: file.filePath,
        size: file.chunks.reduce((total, chunk) => total + chunk.content.length, 0),
        language: file.language,
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      })),
    },
    symbolIndex: fixture.files.flatMap((file) => file.chunks.flatMap((chunk) =>
      chunk.symbols.map((symbol) => ({
        filePath: file.filePath,
        symbolName: symbol,
        kind: "function" as const,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      })))),
    graphSource: empty,
  };
}
