import { describe, expect, it } from "vitest";

import { exportArchitectureMarkdown } from "./architectureMarkdownExport.js";

describe("architecture markdown snapshot", () => {
  it("matches expected markdown output", () => {
    const markdown = exportArchitectureMarkdown({
      findings: [
        {
          title: "High Internal Coupling",
          severity: "CRITICAL",
          description:
            "Modules have a high level of dependency coupling.",
          recommendation:
            "Reduce direct dependencies and improve separation of concerns.",
        },
      ],
      recommendationCount: 1,
      summary: {
        riskLevel: "HIGH",
        couplingLevel: "HIGH",
        couplingScore: 90,
        summary: "Architecture requires attention.",
      },
    });

    expect(markdown).toMatchSnapshot();
  });
});