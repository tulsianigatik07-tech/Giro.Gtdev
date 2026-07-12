// Repository-aware AI chat orchestrator.

import { buildContext } from "../context/contextAssembler.js";
import { buildPrompt } from "./promptBuilder.js";
import { streamCompletion } from "./provider.js";
import { safeStream } from "./stream.js";
import type { Citation } from "./types.js";

export interface ChatResult {
  stream: AsyncGenerator<string>;
  citations: Citation[];
  contextStats: {
    totalChunks: number;
    estimatedTokens: number;
  };
}

export async function runRepositoryChat(query: string, options: { signal?: AbortSignal } = {}): Promise<ChatResult> {
  const context = await buildContext(query, undefined, options);

  const { systemPrompt, userPrompt, citations } = buildPrompt(query, context);

  const rawStream = await streamCompletion([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], { signal: options.signal });

  return {
    stream: safeStream(rawStream),
    citations,
    contextStats: {
      totalChunks: context.totalChunks,
      estimatedTokens: context.estimatedTokens,
    },
  };
}
