import { describe, expect, it } from "vitest";

import { analyzeArchitectureComponents } from "../services/repository/architectureComponentAnalysis.js";

describe("architecture component analysis", () => {
  it("analyzes repository components", () => {
    const result = analyzeArchitectureComponents(
      "demo/repo",
      [
        "src/routes/index.ts",
        "src/services/auth.ts",
      ],
      [],
    );

    expect(result).toBeDefined();
    expect(result.repositoryId).toBe("demo/repo");
    expect(Array.isArray(result.matches)).toBe(true);
  });
});