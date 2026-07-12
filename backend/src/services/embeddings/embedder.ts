import OpenAI, { APIConnectionTimeoutError } from "openai";
import { env } from "../../config/env.js";
import { generateMockEmbedding } from "./mockEmbedder.js";
import { createDeadline, DeadlineExceededError, isDeadlineExceeded } from "../../runtime/deadline.js";

const openai =
  env.EMBEDDINGS_PROVIDER === "openai"
    ? new OpenAI({ apiKey: env.OPENAI_API_KEY })
    : null;

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const MAX_EMBEDDING_CHARS = 8000;

export function normalizeEmbeddingProviderError(error: unknown, signal?: AbortSignal): Error {
  if ((signal?.aborted && isDeadlineExceeded(signal.reason)) || error instanceof APIConnectionTimeoutError) {
    return new DeadlineExceededError();
  }
  return new Error("Embedding generation failed.");
}

export async function generateEmbedding(
  text: string,
  options: { signal?: AbortSignal; timeoutMs?: number; client?: OpenAI } = {},
): Promise<number[]> {
  let normalized = text.replace(/\s+/g, " ").trim();

  if (normalized.length > MAX_EMBEDDING_CHARS) {
    const sliced = normalized.slice(0, MAX_EMBEDDING_CHARS);
    const lastSpace = sliced.lastIndexOf(" ");
    normalized = lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced;
  }

  if (env.EMBEDDINGS_PROVIDER === "mock") {
    if (options.signal?.aborted) throw options.signal.reason;
    return generateMockEmbedding(normalized);
  }

  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? env.EMBEDDING_REQUEST_TIMEOUT_MS, env.EMBEDDING_REQUEST_TIMEOUT_MS));
  const deadline = createDeadline(timeoutMs, { parentSignal: options.signal });
  try {
    const response = await (options.client ?? openai!).embeddings.create({
      model: EMBEDDING_MODEL,
      input: normalized,
    }, { signal: deadline.signal, timeout: timeoutMs });
    const vector = response.data[0]?.embedding;
    if (!vector) throw new Error("Embedding response contained no data");
    return vector;
  } catch (err) {
    throw normalizeEmbeddingProviderError(err, deadline.signal);
  } finally {
    deadline.dispose();
  }
}
