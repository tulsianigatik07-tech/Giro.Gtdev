// Deterministic test fixtures for context budget tests.

import type { EnrichedContextChunk } from "../services/context/contextTypes.js";

export const BUDGET_DEFAULTS = {
  maxChunks: 8,
  maxEstimatedTokens: 3500,
};

export function makeChunk(
  overrides?: Partial<EnrichedContextChunk>,
): EnrichedContextChunk {
  return {
    filePath: "src/a.ts",
    language: "typescript",
    content: "const a = 1;",
    startLine: 1,
    endLine: 10,
    score: 0.5,
    source: "semantic",
    signals: { semantic: 0.5 },
    ...overrides,
  };
}

export function makeChunks(
  count: number,
  overrides?: Partial<EnrichedContextChunk>[],
): EnrichedContextChunk[] {
  return Array.from({ length: count }, (_, i) =>
    makeChunk({
      filePath: `src/file${i}.ts`,
      startLine: i * 100 + 1,
      endLine: i * 100 + 50,
      score: (count - i) / count,
      ...(overrides?.[i] ?? {}),
    }),
  );
}
