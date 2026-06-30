import { describe, expect, it } from "vitest";

import { dedupeRetrievalCandidates } from "../services/retrieval/candidateDeduplication.js";

describe("retrieval candidate deduplication", () => {
  it("deduplicates candidates and keeps highest score", () => {
    const result = dedupeRetrievalCandidates([
      { filePath: "a.ts", content: "same", score: 0.4 },
      { filePath: "a.ts", content: "same", score: 0.9 },
      { filePath: "b.ts", content: "other", score: 0.7 },
    ]);

    expect(result).toEqual([
      { filePath: "a.ts", content: "same", score: 0.9 },
      { filePath: "b.ts", content: "other", score: 0.7 },
    ]);
  });
});