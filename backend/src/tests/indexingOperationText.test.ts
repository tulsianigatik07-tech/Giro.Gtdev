import { describe, expect, it } from "vitest";

import { buildIndexingOperationText } from "../services/repository/indexingOperationText.js";

describe("indexing operation text", () => {
  it("formats operation progress", () => {
    const result = buildIndexingOperationText({
      repoId: "demo/repo",
      status: "running",
      totalSteps: ["clone", "scan", "index"],
      completedSteps: ["clone"],
    });

    expect(result).toContain("demo/repo");
    expect(result).toContain("running");
    expect(result).toContain("1/3");
  });
});