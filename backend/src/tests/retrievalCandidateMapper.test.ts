import { describe, expect, it } from "vitest";

import { mapChunksToCandidates } from "../services/retrieval/candidateMapper.js";

describe("retrieval candidate mapper", () => {
  it("maps retrieval chunks into candidates", () => {
    const candidates = mapChunksToCandidates([
      {
        filePath: "src/app.ts",
        content: "export const app = true;",
        score: 0.8,
      },
    ]);

    expect(candidates).toEqual([
      {
        filePath: "src/app.ts",
        content: "export const app = true;",
        score: 0.8,
      },
    ]);
  });

  it("defaults missing score to zero", () => {
    const candidates = mapChunksToCandidates([
      {
        filePath: "src/app.ts",
        content: "hello",
      },
    ]);

    expect(candidates[0]?.score).toBe(0);
  });
});