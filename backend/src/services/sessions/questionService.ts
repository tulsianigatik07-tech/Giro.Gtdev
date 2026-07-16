// Deterministic ask orchestration: load session -> gather context -> assemble
// answer -> persist messages. Graceful degradation on retrieval, hard fail on persist.

import {
  getSessionById,
  addMessageToSession,
  replaceSelectedContext,
} from "./sessionService.js";
import {
  buildAnswerCitations,
  buildAnswerSources,
  buildGroundedAnswer,
} from "./answerAssembler.js";
import type { AskResult, RepositorySummaryView } from "./answerTypes.js";
import type { SelectedContextChunk } from "./types.js";
import { assembleEnrichedContext } from "../context/enrichedAssembler.js";
import { trimContextToBudget } from "../context/contextBudget.js";
import { buildRetrievalMetadata } from "../retrieval/retrievalMetadataExposure.js";
import { executeRetrieval } from "../retrieval/retrievalExecutionService.js";
import { mapChunksToCandidates } from "../retrieval/candidateMapper.js";
import { searchRepositoryFiles as searchFiles } from "../fileSearch/index.js";
import { analyzeRepoDependencies } from "../graph/index.js";
import { repoClonePath } from "../repository/clone.js";
import { scanRepo } from "../repository/scanner.js";
import { analyzeRepository } from "../repository/analyzer.js";
import { logger } from "../../lib/logger.js";
import { isDeadlineExceeded } from "../../runtime/deadline.js";
import { isDependencyUnavailable } from "../../runtime/circuitBreaker.js";
import type { RetrievalCache } from "../retrieval/cache/retrievalCache.js";
import {
  enrichedChunksToConfidenceCandidates,
  toPublicRetrievalConfidence,
} from "../retrieval/confidence/retrievalConfidence.js";
import {
  evaluateRuntimeRetrievalConfidence,
  recordRuntimeAnswerSuppressed,
} from "../retrieval/confidence/runtimeRetrievalConfidence.js";
import type { RetrievalConfidenceResult } from "../retrieval/confidence/confidenceTypes.js";

export const INSUFFICIENT_REPOSITORY_EVIDENCE_MESSAGE =
  "I could not find enough repository evidence to answer this reliably.";
export const LOW_REPOSITORY_EVIDENCE_WARNING =
  "Evidence is limited, so treat this answer as provisional.";

export function applySessionConfidenceBehavior(
  groundedAnswer: string,
  confidence: RetrievalConfidenceResult,
): string {
  if (!confidence.answerable) return INSUFFICIENT_REPOSITORY_EVIDENCE_MESSAGE;
  if (confidence.level === "low") {
    return `${LOW_REPOSITORY_EVIDENCE_WARNING}\n\n${groundedAnswer}`;
  }
  return groundedAnswer;
}

type QuestionResult = AskResult | "session_not_found";

function toRelativePath(filePath: string): string {
  const marker = ".storage/repos";
  const idx = filePath.indexOf(marker);

  if (idx === -1) {
    return filePath;
  }

  const after = filePath.slice(idx + marker.length);

  return after
    .replace(/\\/g, "/")
    .replace(/^\/[^/]+\/[^/]+\//, "");
}

export async function answerSessionQuestion(
  sessionId: string,
  question: string,
  options: { signal?: AbortSignal; cache?: RetrievalCache } = {},
): Promise<QuestionResult> {
  options.signal?.throwIfAborted();
  const session = getSessionById(sessionId);

  if (!session) {
    return "session_not_found";
  }

  const { owner, repo } = session;

  const summary: RepositorySummaryView = {
    available: false,
    framework: "unknown",
    primaryLanguage: "unknown",
    entrypoints: [],
    centralModules: [],
  };

  try {
    const clonePath = repoClonePath(owner, repo);
    const scanStats = await scanRepo(clonePath);
    const analysis = await analyzeRepository(clonePath, scanStats);

    summary.available = true;
    summary.framework = analysis.framework;
    summary.primaryLanguage = analysis.primaryLanguage;
    summary.entrypoints = analysis.entrypoints;
  } catch (err) {
    if (isDeadlineExceeded(err) || isDependencyUnavailable(err)) throw err;
    logger.warn("repo_summary_unavailable", {
      sessionId,
      owner,
      repo,
      message: err instanceof Error ? err.message : "unknown",
    });
  }

  let usedDependencyGraph = false;

  try {
    const graph = await analyzeRepoDependencies(owner, repo);

    summary.centralModules = graph.insights.centralModules;
    usedDependencyGraph = true;
  } catch (err) {
    if (isDeadlineExceeded(err) || isDependencyUnavailable(err)) throw err;
    logger.warn("dependency_graph_unavailable", {
      sessionId,
      owner,
      repo,
      message: err instanceof Error ? err.message : "unknown",
    });
  }

  const EMPTY_CONTEXT = {
    query: question,
    repository: `${owner}/${repo}`,
    totalChunks: 0,
    estimatedTokens: 0,
    context: [],
    stats: {
      hybridResults: 0,
      fileSearchResults: 0,
      deduplicatedCount: 0,
      finalCount: 0,
      sourceCounts: {
        semantic: 0,
        keyword: 0,
        symbol: 0,
        graph: 0,
        fileSearch: 0,
      },
    },
  };

  let enrichedContext: Awaited<ReturnType<typeof assembleEnrichedContext>> =
    EMPTY_CONTEXT;

  try {
    enrichedContext = await assembleEnrichedContext({
      query: question,
      owner,
      repo,
      maxChars: 16000,
      limit: 25,
    }, options);
  } catch (err) {
    if (isDeadlineExceeded(err) || isDependencyUnavailable(err)) throw err;
    logger.error("enriched_context_failed", {
      sessionId,
      owner,
      repo,
      message: err instanceof Error ? err.message : "unknown",
    });
  }

  let fileResults: Awaited<ReturnType<typeof searchFiles>> = {
    query: question,
    repository: `${owner}/${repo}`,
    results: [],
    totalFilesScanned: 0,
  };

  try {
    fileResults = await searchFiles({
      query: question,
      owner,
      repo,
      limit: 10,
    });
  } catch (err) {
    if (isDeadlineExceeded(err) || isDependencyUnavailable(err)) throw err;
    logger.warn("file_search_failed", {
      sessionId,
      owner,
      repo,
      message: err instanceof Error ? err.message : "unknown",
    });
  }

  const budgetResult = await trimContextToBudget(enrichedContext.context, {
    maxChunks: 8,
    maxEstimatedTokens: 3500,
  });
  options.signal?.throwIfAborted();

  const retrievalCandidates = mapChunksToCandidates(
    budgetResult.selected.map((item) => ({
      filePath: toRelativePath(item.filePath),
      content: item.content,
      score: item.score,
      language: item.language,
      startLine: item.startLine,
      endLine: item.endLine,
      symbol: item.symbol,
      repositoryVersion: item.repositoryVersion,
    })),
  );

  const retrievalExecution = executeRetrieval({
    candidates: retrievalCandidates,
    question,
    minScore: 0,
    maxCandidates: 8,
    maxCharacters: 16000,
    repositoryId: `${owner}/${repo}`,
  });

  const finalContext = { ...enrichedContext, context: budgetResult.selected };
  const sources = buildAnswerSources(question, budgetResult.selected, fileResults.results);
  const citations = buildAnswerCitations(finalContext);
  const confidenceResult = evaluateRuntimeRetrievalConfidence({
    candidates: enrichedChunksToConfidenceCandidates(
      `${owner}/${repo}`,
      budgetResult.selected,
    ),
    citations,
    budgetDropCount:
      (enrichedContext._confidenceBudgetDropCount ?? 0) + budgetResult.dropped.length,
    duplicateSuppressionCount:
      enrichedContext.stats.deduplicatedCount +
      (enrichedContext.stats.rerank?.duplicateChunksRemoved ?? 0),
  });
  const groundedAnswer = confidenceResult.answerable
    ? buildGroundedAnswer(question, finalContext, summary, sources)
    : "";
  const answer = applySessionConfidenceBehavior(groundedAnswer, confidenceResult);
  if (!confidenceResult.answerable) {
    recordRuntimeAnswerSuppressed(confidenceResult);
  }

  try {
    const round3 = (n: number): number => Math.round(n * 1000) / 1000;
    const seen = new Set<string>();
    const selectedChunks: SelectedContextChunk[] = [];

    for (const item of budgetResult.selected) {
      const filePath = toRelativePath(item.filePath);
      const key = `${filePath}:${item.startLine}:${item.endLine}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      selectedChunks.push({
        filePath,
        language: item.language,
        content: item.content,
        startLine: item.startLine,
        endLine: item.endLine,
        score: round3(item.score ?? 0),
        chunkId: item.chunkId,
        symbol: item.symbol,
        repositoryVersion: item.repositoryVersion,
        citationRetrievalType: item.citationRetrievalType,
      });
    }

    selectedChunks.sort(
      (a, b) =>
        b.score - a.score ||
        a.filePath.localeCompare(b.filePath) ||
        a.startLine - b.startLine,
    );

    const top = selectedChunks.slice(0, 10);
    replaceSelectedContext(sessionId, top);

    logger.info("session_context_attached", {
      sessionId,
      selectedChunks: top.length,
    });
  } catch (err) {
    logger.warn("session_context_attach_failed", {
      sessionId,
      owner,
      repo,
      message: err instanceof Error ? err.message : "unknown",
    });
  }

  await addMessageToSession(sessionId, {
    role: "user",
    content: question,
  });

  await addMessageToSession(sessionId, {
    role: "assistant",
    content: answer,
    citations,
  });

  const metadata = {
    retrievedFiles: sources.length,
    usedSummary: summary.available,
    usedDependencyGraph,
    retrievalSourceCounts: enrichedContext.stats.sourceCounts,
    estimatedContextTokens: enrichedContext.estimatedTokens,
    contextBudget: {
      selected: budgetResult.selected.length,
      dropped: budgetResult.dropped.length,
      estimatedTokens: budgetResult.estimatedTokens,
    },
    retrievalExecution: {
      chunkCount: retrievalExecution.chunkCount,
      files: retrievalExecution.files,
    },
    retrieval: buildRetrievalMetadata(enrichedContext.stats),
    confidence: toPublicRetrievalConfidence(confidenceResult),
  };

  logger.info("session_question_answered", {
    sessionId,
    owner,
    repo,
    retrievedFiles: sources.length,
    usedDependencyGraph,
  });

  return {
    answer,
    sources,
    citations,
    metadata,
  };
}
