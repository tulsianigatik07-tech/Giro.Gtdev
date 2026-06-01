// OpenAI streaming completion provider.

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

const MODEL = process.env.MODEL_NAME ?? "gpt-4.1-mini";

const openai = new OpenAI();

export async function streamCompletion(
  messages: ChatCompletionMessageParam[],
): Promise<AsyncIterable<string>> {
  const stream = await openai.chat.completions.create({
    model: MODEL,
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
