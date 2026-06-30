import { describe, expect, it } from "vitest";

import { assembleRetrievalContext } from "../services/retrieval/contextAssembler.js";

describe("retrieval context assembler", () => {
  it("assembles candidates into context", () => {
    const context = assembleRetrievalContext([
      {
        filePath: "src/a.ts",
        content: "export const a = 1;",
        score: 0.9,
      },
      {
        filePath: "src/b.ts",
        content: "export const b = 2;",
        score: 0.8,
      },
    ]);

    expect(context.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(context.chunkCount).toBe(2);
    expect(context.content).toContain("File: src/a.ts");
    expect(context.content).toContain("export const b = 2;");
  });
});