import { describe, expect, it } from "vitest";
import { exportArchitectureMarkdown } from "./architectureMarkdownExport.js";

describe("architecture markdown export", () => {
  it("creates markdown report", () => {
    const markdown = exportArchitectureMarkdown({
      findings: [],
      recommendationCount: 0,
      summary: {
        riskLevel: "LOW",
        couplingLevel: "LOW",
        couplingScore: 0,
        summary: "Healthy architecture",
      },
    });

    expect(markdown).toContain(
      "# Architecture Review Report",
    );
  });
});