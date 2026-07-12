// OpenAI streaming completion provider.

import OpenAI, { APIConnectionTimeoutError } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { env } from "../../config/env.js";
import { createDeadline, DeadlineExceededError, isDeadlineExceeded } from "../../runtime/deadline.js";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export function normalizeAiProviderError(error: unknown, signal?: AbortSignal): unknown {
  return (signal?.aborted && isDeadlineExceeded(signal.reason)) || error instanceof APIConnectionTimeoutError
    ? new DeadlineExceededError()
    : error;
}

export async function streamCompletion(
  messages: ChatCompletionMessageParam[],
  options: { signal?: AbortSignal; timeoutMs?: number; client?: OpenAI } = {},
): Promise<AsyncIterable<string>> {
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? env.AI_REQUEST_TIMEOUT_MS, env.AI_REQUEST_TIMEOUT_MS));
  const deadline = createDeadline(timeoutMs, { parentSignal: options.signal });
  let stream: Awaited<ReturnType<OpenAI["chat"]["completions"]["create"]>>;
  try {
    stream = await (options.client ?? openai).chat.completions.create({
      model: env.MODEL_NAME,
      messages,
      temperature: 0.1,
      stream: true,
    }, { signal: deadline.signal, timeout: timeoutMs });
  } catch (error) {
    deadline.dispose();
    throw normalizeAiProviderError(error, deadline.signal);
  }

  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) yield delta;
        }
      } finally {
        deadline.dispose();
      }
    },
  };
}
