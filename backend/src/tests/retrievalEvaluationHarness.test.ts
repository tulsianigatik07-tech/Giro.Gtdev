import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  DEFAULT_RETRIEVAL_EVALUATION_CONFIGURATIONS,
  externalRetrievalEvaluationConfiguration,
} from "../evaluation/retrieval/configurations.js";
import { evaluateRetrievalBenchmarks } from "../evaluation/retrieval/evaluator.js";
import {
  EvaluationFixtureCompatibilityError,
  loadBenchmarkSuite,
  loadRepositoryFixtureSuite,
  requirePublishedFixture,
} from "../evaluation/retrieval/fixtures.js";
import {
  computeRetrievalMetrics,
  estimateEvaluationTokens,
} from "../evaluation/retrieval/metrics.js";
import {
  evaluateRegressionThresholds,
  regressionExitCode,
} from "../evaluation/retrieval/regression.js";
import {
  RETRIEVAL_BENCHMARK_CATEGORIES,
  RetrievalBenchmarkCaseSchema,
} from "../evaluation/retrieval/schema.js";
import {
  compareWithBaseline,
  terminalEvaluationSummary,
  toBaselineReport,
  updateBaseline,
  writeEvaluationReport,
  type RetrievalEvaluationReport,
} from "../evaluation/retrieval/report.js";
import type { CrossEncoder } from "../services/retrieval/hybridV2/crossEncoder.js";
import type { RetrievalResult } from "../services/retrieval/types.js";

function benchmark() {
  return RetrievalBenchmarkCaseSchema.parse({
    benchmarkId: "metric-case",
    repositoryFixture: "fixture",
    repositoryRevision: "v1",
    query: "find alpha",
    expectedRelevantFiles: ["src/a.ts", "src/b.ts"],
    expectedRelevantSymbols: ["alpha", "beta"],
    expectedRelevantChunks: ["a", "b"],
    excludedFiles: ["vendor/a.ts"],
    category: "exact symbol lookup",
    difficulty: "easy",
  });
}

function result(
  chunkId: string,
  filePath: string,
  symbol: string,
  content = "export const value = true;",
): RetrievalResult {
  return {
    repository: "fixtures/repo",
    filePath,
    language: "typescript",
    content,
    startLine: 1,
    endLine: 1,
    score: 1,
    source: "semantic",
    signals: { semantic: 1 },
    chunkId,
    symbol,
  };
}

function fixedClock(): () => number {
  let value = 0;
  return () => value++;
}

test("retrieval metric formulas produce correct Recall@K, Precision@K, MRR, and nDCG", () => {
  const metrics = computeRetrievalMetrics(benchmark(), [
    result("a", "src/a.ts", "alpha"),
    result("irrelevant", "src/c.ts", "gamma"),
  ], 2, { latencyMs: 7, rerankerAttempts: 2, rerankerFailures: 1, rerankerFallbacks: 1 });
  assert.equal(metrics.recallAtK, 0.5);
  assert.equal(metrics.precisionAtK, 0.5);
  assert.equal(metrics.mrr, 1);
  assert.ok(Math.abs(metrics.ndcgAtK - 0.6131471927654584) < 1e-12);
  assert.equal(metrics.fileLevelRecall, 0.5);
  assert.equal(metrics.symbolLevelRecall, 0.5);
  assert.equal(metrics.latencyMs, 7);
  assert.equal(metrics.rerankerFailureRate, 0.5);
  assert.equal(metrics.rerankerFallbackRate, 0.5);
});

test("ranking metric edge cases are finite for empty and truncated rankings", () => {
  const empty = computeRetrievalMetrics(benchmark(), [], 0);
  assert.equal(empty.recallAtK, 0);
  assert.equal(empty.precisionAtK, 0);
  assert.equal(empty.mrr, 0);
  assert.equal(empty.ndcgAtK, 0);
  assert.equal(Object.values(empty).every(Number.isFinite), true);
});

test("benchmark schema validates required fields and fixtures cover every category", async () => {
  assert.throws(() => RetrievalBenchmarkCaseSchema.parse({
    benchmarkId: "missing-fields",
    query: "query",
  }));
  const suite = await loadBenchmarkSuite();
  assert.deepEqual(
    [...new Set(suite.cases.flatMap((item) => item.category ? [item.category] : []))].sort(),
    [...RETRIEVAL_BENCHMARK_CATEGORIES].sort(),
  );
  assert.ok(suite.cases.every((item) => item.expectedRelevantFiles.length > 0));
});

test("published revision enforcement and embedding mismatch handling fail closed", async () => {
  const fixtures = await loadRepositoryFixtureSuite();
  assert.throws(
    () => requirePublishedFixture(fixtures, "checkout-typescript", "checkout-working"),
    (error: unknown) =>
      error instanceof EvaluationFixtureCompatibilityError &&
      error.reason === "revision_not_published",
  );
  assert.throws(
    () => requirePublishedFixture(
      fixtures,
      "checkout-typescript",
      "checkout-v1",
      { model: "incompatible-model" },
    ),
    (error: unknown) =>
      error instanceof EvaluationFixtureCompatibilityError &&
      error.reason === "embedding_mismatch",
  );
});

test("duplicate, diversity, and token-efficiency metrics are deterministic", () => {
  const relevant = result("a", "src/a.ts", "alpha", "a".repeat(40));
  const metrics = computeRetrievalMetrics(benchmark(), [
    relevant,
    { ...relevant },
    result("noise", "src/noise.ts", "noise", "b".repeat(80)),
  ], 3);
  assert.equal(metrics.duplicateRate, 1 / 3);
  assert.equal(metrics.fileDiversity, 2 / 3);
  assert.equal(estimateEvaluationTokens(relevant.content), 10);
  assert.equal(metrics.relevantTokensPerTotalTokens, 0.5);
  assert.equal(metrics.tokenEfficiency, 50);
});

test("repeated evaluation with fixed snapshots produces identical reports", async () => {
  const [benchmarks, fixtures] = await Promise.all([
    loadBenchmarkSuite(),
    loadRepositoryFixtureSuite(),
  ]);
  const subset = {
    ...benchmarks,
    cases: benchmarks.cases.slice(0, 3),
  };
  const configuration = DEFAULT_RETRIEVAL_EVALUATION_CONFIGURATIONS.find(
    (item) => item.id === "hybrid-deterministic",
  )!;
  const evaluate = () => evaluateRetrievalBenchmarks({
    benchmarks: subset,
    fixtures,
    configurations: [configuration],
    now: fixedClock(),
    generatedAt: () => "2026-01-01T00:00:00.000Z",
    includeBaselineComparison: false,
  });
  assert.deepEqual(await evaluate(), await evaluate());
});

test("lexical, semantic, budget, and diversity configurations are compared separately", async () => {
  const configurations = DEFAULT_RETRIEVAL_EVALUATION_CONFIGURATIONS.filter((item) =>
    ["lexical-only", "semantic-only", "hybrid-tight-budget", "hybrid-high-diversity"]
      .includes(item.id));
  const report = await evaluateRetrievalBenchmarks({
    configurations,
    now: fixedClock(),
    generatedAt: () => "2026-01-01T00:00:00.000Z",
    includeBaselineComparison: false,
  });
  assert.deepEqual(report.configurations.map((item) => item.configuration.id), [
    "hybrid-high-diversity",
    "hybrid-tight-budget",
    "lexical-only",
    "semantic-only",
  ]);
  assert.notEqual(
    report.configurations.find((item) => item.configuration.id === "lexical-only")?.aggregate.recallAtK,
    report.configurations.find((item) => item.configuration.id === "semantic-only")?.aggregate.recallAtK,
  );
});

test("external reranker failure and fallback rates are measured without credentials", async () => {
  const benchmarks = await loadBenchmarkSuite();
  const failing: CrossEncoder = {
    name: "offline-failure",
    verify: () => undefined,
    rerank: async () => { throw new Error("offline"); },
  };
  const report = await evaluateRetrievalBenchmarks({
    benchmarks: { ...benchmarks, cases: benchmarks.cases.slice(0, 1) },
    configurations: [externalRetrievalEvaluationConfiguration("test")],
    externalCrossEncoder: failing,
    now: fixedClock(),
    generatedAt: () => "2026-01-01T00:00:00.000Z",
    includeBaselineComparison: false,
  });
  assert.equal(report.configurations[0]?.aggregate.rerankerFailureRate, 1);
  assert.equal(report.configurations[0]?.aggregate.rerankerFallbackRate, 1);
});

test("regression gates detect failures and return a non-zero command status", async () => {
  const report = await evaluateRetrievalBenchmarks({
    configurations: [DEFAULT_RETRIEVAL_EVALUATION_CONFIGURATIONS[0]!],
    now: fixedClock(),
    generatedAt: () => "2026-01-01T00:00:00.000Z",
    includeBaselineComparison: false,
  });
  const thresholds = {
    configurationId: report.configurations[0]!.configuration.id,
    minimumRecallAtK: 1,
    minimumMrr: 1,
    minimumNdcgAtK: 1,
    minimumFileDiversity: 1,
    maximumDuplicateRate: 0,
    maximumLatencyMs: 0,
  };
  assert.ok(evaluateRegressionThresholds(report, thresholds).length > 0);
  assert.equal(regressionExitCode(report, thresholds), 1);
});

test("baseline updates require confirmation and explicit overwrite", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "giro-retrieval-baseline-"));
  const baselinePath = path.join(directory, "baseline.json");
  const report = await evaluateRetrievalBenchmarks({
    configurations: [DEFAULT_RETRIEVAL_EVALUATION_CONFIGURATIONS[0]!],
    now: fixedClock(),
    generatedAt: () => "2026-01-01T00:00:00.000Z",
    includeBaselineComparison: false,
  });
  await assert.rejects(() => updateBaseline(report, { baselinePath }), /--confirm/);
  await updateBaseline(report, { baselinePath, confirm: true });
  await assert.rejects(
    () => updateBaseline(report, { baselinePath, confirm: true }),
    /--overwrite/,
  );
  await updateBaseline(report, { baselinePath, confirm: true, overwrite: true });
  assert.equal(JSON.parse(await readFile(baselinePath, "utf8")).schemaVersion, 1);
});

test("JSON report generation, terminal summary, and baseline deltas are complete", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "giro-retrieval-report-"));
  const reportPath = path.join(directory, "report.json");
  const report = await evaluateRetrievalBenchmarks({
    configurations: [DEFAULT_RETRIEVAL_EVALUATION_CONFIGURATIONS[0]!],
    now: fixedClock(),
    generatedAt: () => "2026-01-01T00:00:00.000Z",
    includeBaselineComparison: false,
  });
  await writeEvaluationReport(report, reportPath);
  const parsed = JSON.parse(await readFile(reportPath, "utf8")) as RetrievalEvaluationReport;
  assert.equal(parsed.benchmarkVersion, report.benchmarkVersion);
  assert.match(terminalEvaluationSummary(report), /recall=/);
  const baseline = toBaselineReport(report);
  baseline.configurations[report.configurations[0]!.configuration.id]!.recallAtK -= 0.1;
  const comparison = compareWithBaseline(report, baseline);
  assert.ok(
    (comparison.configurations[report.configurations[0]!.configuration.id]
      ?.recallAtK?.delta ?? 0) > 0,
  );
});

test("baseline fixture is checked in as valid machine-readable JSON", async () => {
  const baseline = JSON.parse(await readFile(
    path.resolve("evaluation/retrieval/baselines/hybrid-v2.json"),
    "utf8",
  ));
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.benchmarkVersion, "hybrid-v2-fixtures-1");
  assert.ok(baseline.configurations["hybrid-deterministic"]);
});
