import { describe, expect, it } from "vitest";

import { buildRepositoryIntelligenceText } from "../services/repository/repositoryIntelligenceText.js";

describe("repository intelligence text", () => {
  it("formats repository intelligence summary", () => {
    const text = buildRepositoryIntelligenceText({
      score: 88,
      grade: "excellent",
    });

    expect(text).toContain("Repository Intelligence");
    expect(text).toContain("88");
    expect(text).toContain("excellent");
  });
});