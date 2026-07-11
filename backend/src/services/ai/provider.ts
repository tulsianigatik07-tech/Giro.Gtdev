// OpenAI streaming completion provider.

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { env } from "../../config/env.js";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export async function streamCompletion(
  messages: ChatCompletionMessageParam[],
): Promise<AsyncIterable<string>> {
  const stream = await openai.chat.completions.create({
    model: env.MODEL_NAME,
    messages,
    temperature: 0.1,
    stream: true,
  });

  return {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    },
  };
}
