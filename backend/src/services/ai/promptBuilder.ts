// Builds structured prompts for repository-aware AI chat.

import type { AssembledContext } from "../context/contextAssembler.js";
import type { Citation } from "./types.js";

const SYSTEM_PROMPT = `You are Giro, a senior software engineer assistant specialized in repository understanding.

RULES:
- Answer ONLY from the provided repository context below.
- Do NOT hallucinate or invent code that is not in the context.
- If the context is insufficient to answer, explicitly say: "I don't have enough context to answer this accurately."
- Reference specific files and line numbers when possible.
- Be concise, precise, and technically accurate.
- Format code references as: \`filePath:startLine-endLine\`
- Behave like a senior engineer explaining code to a colleague.`;

export interface BuiltPrompt {
  systemPrompt: string;
  userPrompt: string;
  citations: Citation[];
}

export function buildPrompt(
  query: string,
  context: AssembledContext,
): BuiltPrompt {
  const citations: Citation[] = context.context.map((c) => ({
    filePath: c.filePath,
    startLine: c.startLine,
    endLine: c.endLine,
  }));

  const contextBlock = context.context
    .map(
      (c) =>
        `--- ${c.filePath}:${c.startLine}-${c.endLine} [${c.language}] ---\n${c.content}`,
    )
    .join("\n\n");

  const userPrompt = `REPOSITORY CONTEXT (${context.totalChunks} chunks, ~${context.estimatedTokens} tokens):

${contextBlock}

---

USER QUESTION:
${query}`;

  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    citations,
  };
}
