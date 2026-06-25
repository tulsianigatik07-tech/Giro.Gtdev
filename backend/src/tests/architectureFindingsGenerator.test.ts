import { describe, expect, it } from "vitest";

import { generateArchitectureFindings } from "../services/repository/architectureFindingsGenerator.js";

describe("architecture findings generator", () => {
  it("generates findings for high risk architecture", () => {
    const findings = generateArchitectureFindings({
      riskLevel: "HIGH",
    } as never);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe("High Internal Coupling");
    expect(findings[0]?.severity).toBe("CRITICAL");
  });

  it("generates findings for medium risk architecture", () => {
    const findings = generateArchitectureFindings({
      riskLevel: "MEDIUM",
    } as never);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe("Moderate Internal Coupling");
    expect(findings[0]?.severity).toBe("WARNING");
  });

  it("generates findings for low risk architecture", () => {
    const findings = generateArchitectureFindings({
      riskLevel: "LOW",
    } as never);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe("Healthy Architecture");
    expect(findings[0]?.severity).toBe("INFO");
  });
});