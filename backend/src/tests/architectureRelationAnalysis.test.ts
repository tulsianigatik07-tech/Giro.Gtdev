import { describe, expect, it } from "vitest";

import { analyzeArchitectureRelations } from "../services/repository/architectureRelationAnalysis.js";

describe("architecture relation analysis", () => {
  it("analyzes relations between architecture components", () => {
    const result = analyzeArchitectureRelations(
      "demo/repo",
      [
        "routes",
        "services",
        "database",
      ],
      "depends_on",
    );

    expect(result).toBeDefined();
    expect(result.repositoryId).toBe("demo/repo");
    expect(Array.isArray(result.matches)).toBe(true);
  });
});