// Repository-aware AI chat orchestrator.

import { buildContext } from "../context/contextAssembler.js";
import { buildPrompt } from "./promptBuilder.js";
import { streamCompletion } from "./provider.js";
import { safeStream } from "./stream.js";
import type { Citation } from "./types.js";
import { buildCitations } from "../retrieval/citations.js";
import {
  evaluateRuntimeRetrievalConfidence,
  recordRuntimeAnswerSuppressed,
} from "../retrieval/confidence/runtimeRetrievalConfidence.js";
import { toPublicRetrievalConfidence } from "../retrieval/confidence/retrievalConfidence.js";
import type { PublicRetrievalConfidence } from "../retrieval/confidence/confidenceTypes.js";

const INSUFFICIENT_EVIDENCE_MESSAGE =
  "I could not find enough repository evidence to answer this reliably.";
const LOW_CONFIDENCE_WARNING =
  "Evidence is limited, so treat this answer as provisional.\n\n";

export interface ChatResult {
  stream: AsyncGenerator<string>;
  citations: Citation[];
  contextStats: {
    totalChunks: number;
    estimatedTokens: number;
  };
  confidence?: PublicRetrievalConfidence;
}

export interface RepositoryChatOptions {
  signal?: AbortSignal;
  requestId?: string;
  buildContext?: typeof buildContext;
  buildPrompt?: typeof buildPrompt;
  streamCompletion?: typeof streamCompletion;
}

async function* fallbackStream(): AsyncGenerator<string> {
  yield INSUFFICIENT_EVIDENCE_MESSAGE;
}

async function* lowConfidenceStream(
  stream: AsyncIterable<string>,
): AsyncGenerator<string> {
  yield LOW_CONFIDENCE_WARNING;
  yield* stream;
}

export async function runRepositoryChat(
  query: string,
  options: RepositoryChatOptions = {},
): Promise<ChatResult> {
  const context = await (options.buildContext ?? buildContext)(query, undefined, options);

  const { systemPrompt, userPrompt, citations } = (options.buildPrompt ?? buildPrompt)(query, context);
  const confidenceCitations = buildCitations(context.context.map((chunk) => ({
    repositoryId: chunk.repository,
    filePath: chunk.filePath,
    language: chunk.language,
    chunkId: chunk.chunkId,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    retrievalType: "semantic" as const,
    score: chunk.similarity,
    repositoryVersion: "unversioned",
  })), { surface: "semantic" });
  const confidenceResult = evaluateRuntimeRetrievalConfidence({
    candidates: context.context.map((chunk) => ({
      repositoryId: chunk.repository,
      repositoryVersion: "unversioned",
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      finalScore: chunk.similarity,
      signals: { semantic: chunk.similarity },
      retrievalSources: ["semantic"],
      primaryQueryMatch: true,
    })),
    citations: confidenceCitations,
  });

  if (!confidenceResult.answerable) {
    recordRuntimeAnswerSuppressed(confidenceResult);
    return {
      stream: fallbackStream(),
      citations,
      contextStats: {
        totalChunks: context.totalChunks,
        estimatedTokens: context.estimatedTokens,
      },
      confidence: toPublicRetrievalConfidence(confidenceResult),
    };
  }

  const rawStream = await (options.streamCompletion ?? streamCompletion)([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], { signal: options.signal, requestId: options.requestId });

  return {
    stream: confidenceResult.level === "low"
      ? lowConfidenceStream(safeStream(rawStream))
      : safeStream(rawStream),
    citations,
    contextStats: {
      totalChunks: context.totalChunks,
      estimatedTokens: context.estimatedTokens,
    },
    confidence: toPublicRetrievalConfidence(confidenceResult),
  };
}
