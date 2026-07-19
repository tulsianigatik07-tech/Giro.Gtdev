import assert from "node:assert/strict";
import { test } from "node:test";

import { MetricsRegistry } from "../observability/metrics.js";
import { RetrievalCache } from "../services/retrieval/cache/retrievalCache.js";
import type { Citation } from "../services/retrieval/citations.js";
import type {
  RetrievalConfidenceCandidate,
  RetrievalConfidenceResult,
  RetrievalConfidenceThresholds,
} from "../services/retrieval/confidence/confidenceTypes.js";
import {
  evaluateRetrievalConfidence,
  toPublicRetrievalConfidence,
} from "../services/retrieval/confidence/retrievalConfidence.js";
import {
  evaluateRuntimeRetrievalConfidence,
  recordRuntimeAnswerSuppressed,
} from "../services/retrieval/confidence/runtimeRetrievalConfidence.js";
import {
  applySessionConfidenceBehavior,
  INSUFFICIENT_REPOSITORY_EVIDENCE_MESSAGE,
  LOW_REPOSITORY_EVIDENCE_WARNING,
} from "../services/sessions/questionService.js";

const THRESHOLDS: RetrievalConfidenceThresholds = {
  high: 0.8,
  medium: 0.6,
  low: 0.35,
  minimumCitationCoverage: 0.5,
  minimumAnswerableScore: 0.35,
};

function candidate(
  filePath: string,
  score: number,
  overrides: Partial<RetrievalConfidenceCandidate> = {},
): RetrievalConfidenceCandidate {
  return {
    repositoryId: "acme/widgets",
    repositoryVersion: "v1",
    filePath,
    startLine: 1,
    endLine: 10,
    finalScore: score,
    signals: { semantic: score },
    retrievalSources: ["semantic"],
    primaryQueryMatch: true,
    ...overrides,
  };
}

function citation(
  filePath: string,
  overrides: Partial<Citation> = {},
): Citation {
  return {
    repositoryId: "acme/widgets",
    relativeFilePath: filePath,
    language: "typescript",
    chunkId: `${filePath}:1-10`,
    startLine: 1,
    endLine: 10,
    retrievalType: "hybrid",
    score: 0.9,
    repositoryVersion: "v1",
    ...overrides,
  };
}

function evaluate(
  candidates: readonly RetrievalConfidenceCandidate[],
  citations: readonly Citation[],
  overrides: Partial<{
    budgetDropCount: number;
    duplicateSuppressionCount: number;
    thresholds: RetrievalConfidenceThresholds;
  }> = {},
) {
  return evaluateRetrievalConfidence({
    candidates,
    citations,
    thresholds: overrides.thresholds ?? THRESHOLDS,
    budgetDropCount: overrides.budgetDropCount,
    duplicateSuppressionCount: overrides.duplicateSuppressionCount,
  });
}

function strongEvidence(): {
  candidates: RetrievalConfidenceCandidate[];
  citations: Citation[];
} {
  return {
    candidates: [
      candidate("src/auth/controller.ts", 1, {
        signals: { semantic: 1, keyword: 1, symbol: 1, graph: 1 },
        retrievalSources: ["semantic", "keyword", "symbol", "graph"],
      }),
      candidate("src/auth/service.ts", 0.95, {
        signals: { semantic: 0.95, keyword: 0.9, symbol: 0.8, graph: 0.7 },
        retrievalSources: ["semantic", "keyword", "symbol", "graph"],
      }),
    ],
    citations: [citation("src/auth/controller.ts"), citation("src/auth/service.ts")],
  };
}

test("no candidates is deterministically insufficient", () => {
  const result = evaluate([], []);
  assert.equal(result.level, "insufficient");
  assert.equal(result.score, 0);
  assert.equal(result.answerable, false);
  assert.deepEqual(result.reasons, ["no_retrieval_evidence"]);
});

test("missing valid citations suppresses an otherwise strong match", () => {
  const result = evaluate([candidate("src/auth.ts", 1)], []);
  assert.equal(result.answerable, false);
  assert.equal(result.reasons.includes("missing_citations"), true);
  assert.equal(result.warnings.includes("citation_metadata_incomplete"), true);
});

test("one strong direct grounded match remains answerable without fabricating high confidence", () => {
  const result = evaluate(
    [candidate("src/auth.ts", 0.95)],
    [citation("src/auth.ts")],
  );
  assert.equal(result.level, "medium");
  assert.equal(result.answerable, true);
  assert.equal(result.reasons.includes("strong_top_match"), true);
  assert.equal(result.evidence.citationCoverage, 1);
});

test("several weak matches do not become high confidence by count alone", () => {
  const candidates = Array.from({ length: 8 }, (_, index) =>
    candidate(`src/weak-${index}.ts`, 0.2)
  );
  const citations = candidates.map((item) => citation(item.filePath));
  const result = evaluate(candidates, citations);
  assert.notEqual(result.level, "high");
  assert.equal(result.reasons.includes("weak_top_match"), true);
});

test("semantic-symbol and semantic-keyword agreement improve confidence", () => {
  const semantic = candidate("src/a.ts", 0.8, { signals: { semantic: 0.8 } });
  const semanticSymbol = candidate("src/a.ts", 0.8, {
    signals: { semantic: 0.8, symbol: 0.8 },
    retrievalSources: ["semantic", "symbol"],
  });
  const semanticKeyword = candidate("src/a.ts", 0.8, {
    signals: { semantic: 0.8, keyword: 0.8 },
    retrievalSources: ["semantic", "keyword"],
  });
  const grounded = [citation("src/a.ts")];
  assert.ok(evaluate([semanticSymbol], grounded).score > evaluate([semantic], grounded).score);
  assert.ok(evaluate([semanticKeyword], grounded).score > evaluate([semantic], grounded).score);
});

test("graph-supported evidence and multiple supporting files emit stable positive reasons", () => {
  const evidence = strongEvidence();
  const result = evaluate(evidence.candidates, evidence.citations);
  assert.equal(result.level, "high");
  assert.equal(result.reasons.includes("symbol_graph_support"), true);
  assert.equal(result.reasons.includes("cross_file_support"), true);
  assert.equal(result.reasons.includes("diverse_retrieval_sources"), true);
});

test("repository-summary-only evidence is never answerable", () => {
  const summary = candidate("__repository_summary__", 1, {
    repositorySummary: true,
    signals: { graph: 1 },
    retrievalSources: ["graph"],
  });
  const result = evaluate([summary], [citation("__repository_summary__")]);
  assert.equal(result.answerable, false);
  assert.equal(result.reasons.includes("summary_only_evidence"), true);
  assert.equal(result.evidence.citationCoverage, 0);
});

test("query-expansion-dependent evidence is penalized below direct evidence", () => {
  const direct = candidate("src/a.ts", 0.9);
  const expanded = candidate("src/a.ts", 0.9, {
    primaryQueryMatch: false,
    queryExpansionMatch: true,
  });
  const grounded = [citation("src/a.ts")];
  const directResult = evaluate([direct], grounded);
  const expandedResult = evaluate([expanded], grounded);
  assert.ok(expandedResult.score < directResult.score);
  assert.equal(expandedResult.reasons.includes("expansion_dependent"), true);
  assert.equal(expandedResult.evidence.expansionDependencyRatio, 1);
});

test("stitched blocks count every attached citation while coverage counts the final block once", () => {
  const stitched = candidate("src/a.ts", 0.9, {
    startLine: 1,
    endLine: 20,
    stitchedNeighborCount: 1,
  });
  const result = evaluate([stitched], [
    citation("src/a.ts", { chunkId: "a-1", startLine: 1, endLine: 10 }),
    citation("src/a.ts", { chunkId: "a-2", startLine: 11, endLine: 20 }),
  ]);
  assert.equal(result.evidence.citationCount, 2);
  assert.equal(result.evidence.citationCoverage, 1);
});

test("low citation coverage and excessive budget trimming reduce confidence", () => {
  const candidates = [candidate("src/a.ts", 0.9), candidate("src/b.ts", 0.8)];
  const base = evaluate(candidates, [citation("src/a.ts")]);
  const trimmed = evaluate(candidates, [citation("src/a.ts")], { budgetDropCount: 4 });
  assert.equal(base.reasons.includes("low_citation_coverage"), false);
  const stricter = evaluate(candidates, [citation("src/a.ts")], {
    thresholds: { ...THRESHOLDS, minimumCitationCoverage: 0.75 },
  });
  assert.equal(stricter.reasons.includes("low_citation_coverage"), true);
  assert.ok(trimmed.score < base.score);
  assert.equal(trimmed.reasons.includes("excessive_budget_trimming"), true);
});

test("explicit conflicting signals are penalized only when metadata justifies it", () => {
  const normal = candidate("src/a.ts", 0.9);
  const conflict = candidate("src/a.ts", 0.9, { conflictingSignals: true });
  const grounded = [citation("src/a.ts")];
  assert.ok(evaluate([conflict], grounded).score < evaluate([normal], grounded).score);
  assert.equal(evaluate([conflict], grounded).reasons.includes("conflicting_signals"), true);
});

test("scores and all signal inputs normalize to zero through one", () => {
  const result = evaluate([
    candidate("src/a.ts", 100, {
      signals: { semantic: 100, keyword: -10, symbol: Number.POSITIVE_INFINITY },
    }),
  ], [citation("src/a.ts")]);
  assert.equal(result.evidence.topScore, 1);
  assert.ok(result.score >= 0 && result.score <= 1);
});

test("level threshold boundaries are inclusive and ordered", () => {
  const evidence = [candidate("src/a.ts", 0.95)];
  const citations = [citation("src/a.ts")];
  const baseline = evaluate(evidence, citations, {
    thresholds: { ...THRESHOLDS, high: 1, medium: 0.9, low: 0 },
  });
  const exactHigh = evaluate(evidence, citations, {
    thresholds: {
      ...THRESHOLDS,
      high: baseline.score,
      medium: Math.max(0, baseline.score - 0.1),
      low: Math.max(0, baseline.score - 0.2),
    },
  });
  assert.equal(exactHigh.level, "high");
  const exactMedium = evaluate(evidence, citations, {
    thresholds: {
      ...THRESHOLDS,
      high: Math.min(1, baseline.score + 0.1),
      medium: baseline.score,
      low: Math.max(0, baseline.score - 0.1),
    },
  });
  const exactLow = evaluate(evidence, citations, {
    thresholds: {
      ...THRESHOLDS,
      high: Math.min(1, baseline.score + 0.2),
      medium: Math.min(1, baseline.score + 0.1),
      low: baseline.score,
    },
  });
  const belowLow = evaluate(evidence, citations, {
    thresholds: {
      ...THRESHOLDS,
      high: Math.min(1, baseline.score + 0.03),
      medium: Math.min(1, baseline.score + 0.02),
      low: Math.min(1, baseline.score + 0.01),
    },
  });
  assert.equal(exactMedium.level, "medium");
  assert.equal(exactLow.level, "low");
  assert.equal(belowLow.level, "insufficient");
  assert.throws(() => evaluate(evidence, citations, {
    thresholds: { ...THRESHOLDS, high: 0.5, medium: 0.7 },
  }), /ordered/);
});

test("duplicate suppression and low score separation apply bounded penalties/reasons", () => {
  const evidence = strongEvidence();
  const baseline = evaluate(evidence.candidates, evidence.citations);
  const suppressed = evaluate(evidence.candidates, evidence.citations, {
    duplicateSuppressionCount: 6,
  });
  assert.ok(suppressed.score < baseline.score);
  assert.equal(baseline.reasons.includes("low_score_separation"), true);
});

test("output is deterministic, deeply immutable, and input remains unchanged", () => {
  const evidence = strongEvidence();
  const before = structuredClone(evidence);
  const first = evaluate(evidence.candidates, evidence.citations);
  const second = evaluate(evidence.candidates, evidence.citations);
  assert.deepEqual(second, first);
  assert.deepEqual(evidence, before);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.evidence), true);
  assert.equal(Object.isFrozen(first.reasons), true);
});

test("missing optional metadata degrades safely", () => {
  const minimal: RetrievalConfidenceCandidate = {
    repositoryId: "acme/widgets",
    filePath: "src/a.ts",
    startLine: 1,
    endLine: 10,
    finalScore: 0.7,
  };
  const result = evaluate([minimal], [citation("src/a.ts")]);
  assert.ok(Number.isFinite(result.score));
  assert.equal(result.evidence.retrievalSourceCount, 0);
});

test("repository and version inconsistency is never answerable", () => {
  const result = evaluate([
    candidate("src/a.ts", 1),
    candidate("src/b.ts", 1, { repositoryVersion: "v2" }),
  ], [
    citation("src/a.ts"),
    citation("src/b.ts", { repositoryVersion: "v2" }),
  ]);
  assert.equal(result.answerable, false);
  assert.equal(result.warnings.includes("repository_version_inconsistent"), true);
});

test("cached retrieval confidence is identical and version invalidation reloads it", async () => {
  let version = "v1";
  let loads = 0;
  const cache = new RetrievalCache({
    ttlMs: 10_000,
    maxEntries: 5,
    metrics: new MetricsRegistry(),
    logger: { info: () => undefined },
    versionProvider: () => version,
  });
  const key = { repositoryId: "acme/widgets", query: "auth", mode: "confidence" };
  const loader = async (_signal: AbortSignal, context: { repositoryVersion: string }) => {
    loads += 1;
    return evaluate([
      candidate("src/a.ts", 0.9, { repositoryVersion: context.repositoryVersion }),
    ], [citation("src/a.ts", { repositoryVersion: context.repositoryVersion })]);
  };
  const first = await cache.getOrLoad(key, loader);
  const cached = await cache.getOrLoad(key, loader);
  assert.strictEqual(cached, first);
  version = "v2";
  const refreshed = await cache.getOrLoad(key, loader);
  assert.equal(loads, 2);
  assert.notStrictEqual(refreshed, first);
});

test("session answer behavior preserves high answers, warns on low, and safely suppresses insufficient", () => {
  const high = evaluate(...Object.values(strongEvidence()) as [RetrievalConfidenceCandidate[], Citation[]]);
  const low = evaluate([candidate("src/a.ts", 0.7)], [citation("src/a.ts")]);
  const insufficient = evaluate([], []);
  assert.equal(applySessionConfidenceBehavior("grounded", high), "grounded");
  assert.equal(
    applySessionConfidenceBehavior("grounded", low),
    `${LOW_REPOSITORY_EVIDENCE_WARNING}\n\ngrounded`,
  );
  assert.equal(
    applySessionConfidenceBehavior("grounded", insufficient),
    INSUFFICIENT_REPOSITORY_EVIDENCE_MESSAGE,
  );
});

test("metrics labels are fixed and logs contain only bounded diagnostics", () => {
  const metrics = new MetricsRegistry();
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  let now = 10;
  const secretPath = "src/private/customer.ts";
  const result = evaluateRuntimeRetrievalConfidence({
    candidates: [candidate(secretPath, 0.1)],
    citations: [],
  }, {
    metrics,
    logger: { info: (event, fields) => logs.push({ event, fields }) },
    thresholds: THRESHOLDS,
    now: () => { const current = now; now += 4; return current; },
  });
  recordRuntimeAnswerSuppressed(result, {
    logger: { info: (event, fields) => logs.push({ event, fields }) },
  });

  const output = metrics.render();
  assert.match(output, /giro_retrieval_confidence_total\{level="insufficient"\} 1/);
  assert.match(output, /giro_retrieval_answerability_total\{answerable="false"\} 1/);
  assert.match(output, /giro_retrieval_insufficient_evidence_total\{reason="missing_citations"\} 1/);
  assert.deepEqual(logs.map((entry) => entry.event), [
    "retrieval_confidence_evaluated",
    "retrieval_evidence_insufficient",
    "retrieval_answer_suppressed",
  ]);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(secretPath), false);
  assert.equal(serialized.includes("secret query"), false);
  assert.equal(serialized.includes("prompt"), false);
  assert.equal(serialized.includes("source code"), false);
});

test("low confidence emits its dedicated structured event without suppression", () => {
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const result = evaluateRuntimeRetrievalConfidence({
    candidates: [candidate("src/a.ts", 0.7)],
    citations: [citation("src/a.ts")],
  }, {
    metrics: new MetricsRegistry(),
    logger: { info: (event, fields) => logs.push({ event, fields }) },
    thresholds: THRESHOLDS,
  });
  assert.equal(result.level, "low");
  assert.equal(result.answerable, true);
  assert.deepEqual(logs.map((entry) => entry.event), [
    "retrieval_confidence_evaluated",
    "retrieval_low_confidence",
  ]);
});

test("public metadata is additive, bounded, and excludes internal evidence diagnostics", () => {
  const evidence = strongEvidence();
  const result = evaluate(evidence.candidates, evidence.citations);
  const publicResult = toPublicRetrievalConfidence(result);
  assert.deepEqual(Object.keys(publicResult).sort(), ["answerable", "level", "reasons", "score"]);
  assert.equal("evidence" in publicResult, false);
  assert.equal("warnings" in publicResult, false);

  const legacyCompatible: { confidence?: typeof publicResult } = {};
  assert.deepEqual(legacyCompatible, {});
});
