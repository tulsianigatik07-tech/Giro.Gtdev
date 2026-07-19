// Canonical Ask Giro pipeline: one repository-scoped retrieval is finalized,
// evaluated, used for generation/citations/inspection, and persisted.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { logger } from "../../lib/logger.js";
import { collectStream } from "../ai/stream.js";
import { buildPrompt } from "../ai/promptBuilder.js";
import { streamCompletion } from "../ai/provider.js";
import { trimContextToBudget } from "../context/contextBudget.js";
import { assembleEnrichedContext } from "../context/enrichedAssembler.js";
import type {
  EnrichedAssembledContext,
  EnrichedContextChunk,
} from "../context/contextTypes.js";
import type { RetrievalCache } from "../retrieval/cache/retrievalCache.js";
import {
  enrichedChunksToConfidenceCandidates,
  toPublicRetrievalConfidence,
} from "../retrieval/confidence/retrievalConfidence.js";
import type { RetrievalConfidenceResult } from "../retrieval/confidence/confidenceTypes.js";
import {
  evaluateRuntimeRetrievalConfidence,
  recordRuntimeAnswerSuppressed,
} from "../retrieval/confidence/runtimeRetrievalConfidence.js";
import { buildRetrievalMetadata } from "../retrieval/retrievalMetadataExposure.js";
import {
  buildAnswerCitations,
  buildAnswerSources,
} from "./answerAssembler.js";
import type { AskResult } from "./answerTypes.js";
import {
  addMessageToSession,
  getSessionById,
  replaceSelectedContext,
} from "./sessionService.js";
import type {
  PersistedRetrievalMetadata,
  SelectedContextChunk,
} from "./types.js";

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

type AssembleContext = typeof assembleEnrichedContext;
type GenerateAnswer = (input: {
  question: string;
  repositoryId: string;
  context: readonly EnrichedContextChunk[];
  estimatedTokens: number;
  signal?: AbortSignal;
  requestId?: string;
}) => Promise<string>;

export interface AnswerSessionQuestionOptions {
  signal?: AbortSignal;
  requestId?: string;
  cache?: RetrievalCache;
  assembleContext?: AssembleContext;
  generateAnswer?: GenerateAnswer;
  now?: () => string;
}

function toRelativePath(filePath: string): string {
  const marker = ".storage/repos";
  const index = filePath.indexOf(marker);
  if (index === -1) return filePath.replace(/\\/g, "/");
  return filePath
    .slice(index + marker.length)
    .replace(/\\/g, "/")
    .replace(/^\/[^/]+\/[^/]+\//, "");
}

function toSelectedChunks(
  chunks: readonly EnrichedContextChunk[],
): SelectedContextChunk[] {
  const seen = new Set<string>();
  const selected: SelectedContextChunk[] = [];

  for (const item of chunks) {
    const filePath = toRelativePath(item.filePath);
    const key = `${filePath}:${item.startLine}:${item.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({
      filePath,
      language: item.language,
      content: item.content,
      startLine: item.startLine,
      endLine: item.endLine,
      score: Math.round(item.score * 1000) / 1000,
      source: item.source,
      signals: { ...item.signals },
      chunkId: item.chunkId,
      symbol: item.symbol,
      repositoryVersion: item.repositoryVersion,
      citationRetrievalType: item.citationRetrievalType,
    });
  }

  return selected.sort(
    (a, b) =>
      b.score - a.score ||
      a.filePath.localeCompare(b.filePath) ||
      a.startLine - b.startLine,
  );
}

function countSelectedSources(chunks: readonly EnrichedContextChunk[]) {
  const counts = { semantic: 0, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 };
  for (const chunk of chunks) {
    if (chunk.source === "file-search") counts.fileSearch += 1;
    else counts[chunk.source] += 1;
  }
  return counts;
}

async function generateGroundedAnswer(input: {
  question: string;
  repositoryId: string;
  context: readonly EnrichedContextChunk[];
  estimatedTokens: number;
  signal?: AbortSignal;
  requestId?: string;
}): Promise<string> {
  const prompt = buildPrompt(input.question, {
    query: input.question,
    totalChunks: input.context.length,
    estimatedTokens: input.estimatedTokens,
    context: input.context.map((chunk) => ({
      repository: input.repositoryId,
      filePath: toRelativePath(chunk.filePath),
      language: chunk.language,
      similarity: chunk.score,
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      chunkId: chunk.chunkId,
    })),
  });
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: prompt.systemPrompt },
    { role: "user", content: prompt.userPrompt },
  ];
  const stream = await streamCompletion(messages, {
    signal: input.signal,
    requestId: input.requestId,
  });
  const answer = (await collectStream(stream)).trim();
  if (!answer) throw new Error("The answer provider returned an empty response.");
  return answer;
}

function buildInspectorResult(
  question: string,
  context: EnrichedAssembledContext,
  selected: readonly EnrichedContextChunk[],
  citations: AskResult["citations"],
): AskResult["retrieval"] {
  const sourceCounts = countSelectedSources(selected);
  return {
    query: question,
    repository: context.repository,
    results: selected.map((chunk) => ({
      repository: context.repository,
      filePath: toRelativePath(chunk.filePath),
      language: chunk.language,
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score: chunk.score,
      source: chunk.source,
      signals: { ...chunk.signals },
      chunkId: chunk.chunkId,
      symbol: chunk.symbol,
    })),
    citations,
    stats: {
      semanticResults: sourceCounts.semantic,
      keywordResults: sourceCounts.keyword,
      symbolResults: sourceCounts.symbol,
      graphBoosted: sourceCounts.graph,
      returned: selected.length,
    },
  };
}

export async function answerSessionQuestion(
  sessionId: string,
  question: string,
  options: AnswerSessionQuestionOptions = {},
): Promise<QuestionResult> {
  options.signal?.throwIfAborted();
  const session = getSessionById(sessionId);
  if (!session) return "session_not_found";

  const repositoryId = `${session.owner}/${session.repo}`;
  const context = await (options.assembleContext ?? assembleEnrichedContext)(
    {
      query: question,
      owner: session.owner,
      repo: session.repo,
      maxChars: 16_000,
      limit: 25,
    },
    { signal: options.signal, cache: options.cache },
  );
  const budget = await trimContextToBudget(context.context, {
    maxChunks: 8,
    maxEstimatedTokens: 3_500,
  });
  options.signal?.throwIfAborted();

  const finalContext: EnrichedAssembledContext = {
    ...context,
    totalChunks: budget.selected.length,
    estimatedTokens: budget.estimatedTokens,
    context: budget.selected,
  };
  const citations = buildAnswerCitations(finalContext);
  const confidence = evaluateRuntimeRetrievalConfidence({
    candidates: enrichedChunksToConfidenceCandidates(repositoryId, budget.selected),
    citations,
    budgetDropCount:
      (context._confidenceBudgetDropCount ?? 0) + budget.dropped.length,
    duplicateSuppressionCount:
      context.stats.deduplicatedCount +
      (context.stats.rerank?.duplicateChunksRemoved ?? 0),
  });

  let groundedAnswer = "";
  if (confidence.answerable) {
    groundedAnswer = await (options.generateAnswer ?? generateGroundedAnswer)({
      question,
      repositoryId,
      context: budget.selected,
      estimatedTokens: budget.estimatedTokens,
      signal: options.signal,
      requestId: options.requestId,
    });
  } else {
    recordRuntimeAnswerSuppressed(confidence);
  }
  const answer = applySessionConfidenceBehavior(groundedAnswer, confidence);
  const sources = buildAnswerSources(question, budget.selected, []);
  const evidence = toSelectedChunks(budget.selected);
  const selectedSourceCounts = countSelectedSources(budget.selected);
  const retrievedAt = (options.now ?? (() => new Date().toISOString()))();
  const retrievalMetadata: PersistedRetrievalMetadata = {
    repositoryId,
    retrievedAt,
    sourceCounts: selectedSourceCounts,
    estimatedContextTokens: budget.estimatedTokens,
    selectedChunkCount: evidence.length,
    droppedChunkCount: budget.dropped.length,
    confidence: toPublicRetrievalConfidence(confidence),
  };

  if (!addMessageToSession(sessionId, { role: "user", content: question })) {
    throw new Error("Session disappeared before the question could be persisted.");
  }
  if (!addMessageToSession(sessionId, {
    role: "assistant",
    content: answer,
    citations,
    evidence,
    retrievalMetadata,
  })) {
    throw new Error("Session disappeared before the answer could be persisted.");
  }
  if (!replaceSelectedContext(sessionId, evidence)) {
    throw new Error("Session disappeared before evidence could be persisted.");
  }

  const metadata = {
    retrievedFiles: sources.length,
    usedSummary: budget.selected.some((item) => item.filePath === "__repository_summary__"),
    usedDependencyGraph: selectedSourceCounts.graph > 0,
    retrievalSourceCounts: selectedSourceCounts,
    estimatedContextTokens: budget.estimatedTokens,
    contextBudget: {
      selected: budget.selected.length,
      dropped: budget.dropped.length,
      estimatedTokens: budget.estimatedTokens,
    },
    retrieval: buildRetrievalMetadata(context.stats),
    confidence: toPublicRetrievalConfidence(confidence),
  };

  logger.info("session_question_answered", {
    sessionId,
    repositoryId,
    retrievedFiles: sources.length,
    evidenceChunks: evidence.length,
  });

  return {
    answer,
    sources,
    citations,
    metadata,
    retrieval: buildInspectorResult(question, context, budget.selected, citations),
  };
}
