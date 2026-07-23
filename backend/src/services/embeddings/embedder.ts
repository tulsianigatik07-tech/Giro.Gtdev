import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, RateLimitError } from "openai";
import { env } from "../../config/env.js";
import { generateMockEmbedding } from "./mockEmbedder.js";
import { createDeadline, DeadlineExceededError, isDeadlineExceeded } from "../../runtime/deadline.js";
import { isTransientTransportError, retry, type RetryRuntimeOptions } from "../../runtime/retry.js";
import { createRetryObservability, type RetryLogger, type RetryMetrics } from "../../observability/retryObservability.js";
import { logger } from "../../lib/logger.js";
import { runtimeMetrics } from "../../observability/metrics.js";
import { isDependencyUnavailable, type CircuitBreaker } from "../../runtime/circuitBreaker.js";
import { runtimeDependencyCircuitBreakers } from "../../runtime/dependencyCircuitBreakers.js";

const openai =
  env.EMBEDDINGS_PROVIDER === "openai"
    ? new OpenAI({ apiKey: env.OPENAI_API_KEY })
    : null;

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSION = 1536;
export const MAX_EMBEDDING_CHARS = 8000;

export function normalizeEmbeddingProviderError(error: unknown, signal?: AbortSignal): Error {
  if (isDependencyUnavailable(error)) return error as Error;
  if ((signal?.aborted && isDeadlineExceeded(signal.reason)) || error instanceof APIConnectionTimeoutError) {
    return new DeadlineExceededError();
  }
  return new Error("Embedding generation failed.");
}

export function isTransientEmbeddingError(error: unknown): boolean {
  if (error instanceof RateLimitError || error instanceof APIConnectionTimeoutError || error instanceof APIConnectionError) return true;
  if (error instanceof APIError) return error.status === 408 || error.status === 429 || error.status === 502 || error.status === 503 || error.status === 504;
  return isTransientTransportError(error);
}

export interface EmbeddingProviderOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  client?: OpenAI;
  requestId?: string;
  logger?: RetryLogger;
  metrics?: RetryMetrics;
  retryRuntime?: RetryRuntimeOptions;
  circuitBreaker?: CircuitBreaker;
}

export async function requestOpenAIEmbedding(
  normalized: string,
  options: EmbeddingProviderOptions,
): Promise<number[]> {
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? env.EMBEDDING_REQUEST_TIMEOUT_MS, env.EMBEDDING_REQUEST_TIMEOUT_MS));
  const deadline = createDeadline(timeoutMs, { parentSignal: options.signal });
  const observability = createRetryObservability({
    category: "embedding",
    operation: "embedding_generation",
    logger: options.logger ?? logger,
    metrics: options.metrics ?? runtimeMetrics,
    fields: { requestId: options.requestId },
  });
  try {
    const response = await (options.circuitBreaker ?? runtimeDependencyCircuitBreakers.embedding).execute(
      () => retry(
        async (attempt) => {
          const attemptsRemaining = env.EMBEDDING_MAX_RETRIES + 2 - attempt;
          const attemptTimeoutMs = Math.max(1, Math.floor(deadline.remainingMs() / attemptsRemaining));
          return (options.client ?? openai!).embeddings.create({
            model: EMBEDDING_MODEL,
            input: normalized,
          }, { signal: deadline.signal, timeout: attemptTimeoutMs, maxRetries: 0 });
        },
        {
          maxAttempts: env.EMBEDDING_MAX_RETRIES + 1,
          baseDelayMs: env.EMBEDDING_RETRY_BASE_MS,
          maxDelayMs: 5_000,
          deadline,
          isRetryable: isTransientEmbeddingError,
          ...observability,
          ...options.retryRuntime,
        },
      ),
      { requestId: options.requestId, signal: options.signal },
    );
    const vector = response.data[0]?.embedding;
    if (!vector) throw new Error("Embedding response contained no data");
    return vector;
  } catch (err) {
    throw normalizeEmbeddingProviderError(err, deadline.signal);
  } finally {
    deadline.dispose();
  }
}

export async function generateEmbedding(
  text: string,
  options: EmbeddingProviderOptions = {},
): Promise<number[]> {
  let normalized = text.replace(/\s+/g, " ").trim();

  if (normalized.length > MAX_EMBEDDING_CHARS) {
    const sliced = normalized.slice(0, MAX_EMBEDDING_CHARS);
    const lastSpace = sliced.lastIndexOf(" ");
    normalized = lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced;
  }

  if (env.EMBEDDINGS_PROVIDER === "mock") {
    if (options.signal?.aborted) throw options.signal.reason;
    const vector = generateMockEmbedding(normalized);
    if (vector.length !== EMBEDDING_DIMENSION) throw new Error("Embedding dimension mismatch.");
    return vector;
  }

  const vector = await requestOpenAIEmbedding(normalized, options);
  if (vector.length !== EMBEDDING_DIMENSION) throw new Error("Embedding dimension mismatch.");
  return vector;
}
