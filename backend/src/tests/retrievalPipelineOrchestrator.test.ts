import { describe, expect, it } from "vitest";

import { executeRetrievalPipeline } from "../services/retrieval/retrievalPipelineOrchestrator.js";

describe("retrieval pipeline orchestrator", () => {
  it("runs retrieval pipeline", () => {
    const result = executeRetrievalPipeline({
      question: "What does the repository do?",
      candidates: [
        {
          filePath: "src/index.ts",
          content: "export const app = true;",
          score: 0.9,
        },
      ],
    });

    expect(result.chunkCount).toBe(1);
    expect(result.files).toEqual(["src/index.ts"]);
    expect(result.prompt).toContain("What does the repository do?");
  });
});