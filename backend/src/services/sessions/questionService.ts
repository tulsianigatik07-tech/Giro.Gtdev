// Deterministic ask orchestration: load session -> gather context -> assemble
// answer -> persist messages. Graceful degradation on retrieval, hard fail on persist.

import { getSessionById, addMessageToSession, replaceSelectedContext } from "./sessionService.js";
import { assembleAnswer } from "./answerAssembler.js";
import type { AskResult, RepositorySummaryView } from "./answerTypes.js";
import type { SelectedContextChunk } from "./types.js";
import { assembleEnrichedContext } from "../context/enrichedAssembler.js";
import { trimContextToBudget } from "../context/contextBudget.js";
import { buildRetrievalMetadata } from "../retrieval/retrievalMetadataExposure.js";
import { searchRepositoryFiles as searchFiles } from "../fileSearch/index.js";
import { analyzeRepoDependencies } from "../graph/index.js";
import { repoClonePath } from "../repository/clone.js";
import { scanRepo } from "../repository/scanner.js";
import { analyzeRepository } from "../repository/analyzer.js";
import { logger } from "../../lib/logger.js";
import { executeRetrieval } from "../retrieval/retrievalExecutionService.js";

type QuestionResult = AskResult | "session_not_found";

// Strips the absolute ".storage/repos/<owner>--<repo>/" prefix so persisted
// chunks only carry repository-relative paths.
function toRelativePath(filePath: string): string {
  const marker = ".storage/repos";
  const idx = filePath.indexOf(marker);
  if (idx === -1) return filePath;
  const after = filePath.slice(idx + marker.length);
  return after.replace(/\\/g, "/").replace(/^\/[^/]+\/[^/]+\//, "");
}

export async function answerSessionQuestion(
  sessionId: string,
  question: string,
): Promise<QuestionResult> {
  // STEP 1 — Load session
  const session = getSessionById(sessionId);
  if (!session) return "session_not_found";

  // STEP 2 — Extract owner + repo
  const { owner, repo } = session;

  // STEP 3 — Build RepositorySummaryView (graceful)
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
    logger.warn("repo_summary_unavailable", {
      sessionId,
      owner,
      repo,
      message: err instanceof Error ? err.message : "unknown",
    });
  }

  // STEP 4 — Dependency graph (graceful)
  let usedDependencyGraph = false;
  try {
    const graph = await analyzeRepoDependencies(owner, repo);
    summary.centralModules = graph.insights.centralModules;
    usedDependencyGraph = true;
  } catch (err) {
    logger.warn("dependency_graph_unavailable", {
      sessionId,
      owner,
      repo,
      message: err instanceof Error ? err.message : "unknown",
    });
  }

  // STEP 5 — Enriched context (graceful)
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
      sourceCounts: { semantic: 0, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 },
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
    });
  } catch (err) {
    logger.error("enriched_context_failed", {
      sessionId,
      owner,
      repo,
      message: err instanceof Error ? err.message : "unknown",
    });
  }

  // STEP 6 — File search (graceful)
  let fileResults: Awaited<ReturnType<typeof searchFiles>> = {
    query: question,
    repository: `${owner}/${repo}`,
    results: [],
    totalFilesScanned: 0,
  };
  try {
    fileResults = await searchFiles({ query: question, owner, repo, limit: 10 });
  } catch (err) {
    logger.warn("file_search_failed", {
      sessionId,
      owner,
      repo,
      message: err instanceof Error ? err.message : "unknown",
    });
  }

  // STEP 6.5 — trim context to budget
  const budgetResult = await trimContextToBudget(enrichedContext.context, {
    maxChunks: 8,
    maxEstimatedTokens: 3500,
  });
  const retrievalExecution = executeRetrieval({
  candidates: budgetResult.selected.map((item) => ({
    filePath: toRelativePath(item.filePath),
    content: item.content,
    score: item.score ?? 0,
  })),
  question,
  minScore: 0,
  maxCandidates: 8,
  maxCharacters: 16000,
});

  // STEP 7 — Assemble answer (synchronous)
  const { answer, sources, citations } = assembleAnswer(
    question,
    { ...enrichedContext, context: budgetResult.selected },
    fileResults.results,
    summary,
  );

  // STEP 7.5 — Build and persist selectedContext (graceful)
  try {
    const round3 = (n: number): number => Math.round(n * 1000) / 1000;
    const seen = new Set<string>();
    const selectedChunks: SelectedContextChunk[] = [];

    for (const item of budgetResult.selected) {
      const filePath = toRelativePath(item.filePath);
      const key = `${filePath}:${item.startLine}:${item.endLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      selectedChunks.push({
        filePath,
        language: item.language,
        content: item.content,
        startLine: item.startLine,
        endLine: item.endLine,
        score: round3(item.score ?? 0),
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

  // STEP 8 — Persist messages sequentially (hard fail)
  await addMessageToSession(sessionId, { role: "user", content: question });
  await addMessageToSession(sessionId, {
    role: "assistant",
    content: answer,
    citations,
  });

  // STEP 9 — Build metadata
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
    // Pass-through of retrieval metadata already produced by enrichedAssembler.
    retrieval: buildRetrievalMetadata(enrichedContext.stats),
  };

  // STEP 10 — Log success
  logger.info("session_question_answered", {
    sessionId,
    owner,
    repo,
    retrievedFiles: sources.length,
    usedDependencyGraph,
  });

  // STEP 11 — Return
  return { answer, sources, citations, metadata };
}
