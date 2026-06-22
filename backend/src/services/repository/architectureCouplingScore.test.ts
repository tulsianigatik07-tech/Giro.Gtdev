import { describe, expect, it } from "vitest";

import {
  calculateArchitectureCouplingScore,
} from "./architectureCouplingScore.js";

describe("architecture coupling score", () => {
  it("returns LOW coupling", () => {
    const result = calculateArchitectureCouplingScore({
      nodeCount: 10,
      edgeCount: 2,
      density: 0.1,
    });

    expect(result.level).toBe("LOW");
  });

  it("returns MEDIUM coupling", () => {
    const result = calculateArchitectureCouplingScore({
      nodeCount: 10,
      edgeCount: 20,
      density: 0.5,
    });

    expect(result.level).toBe("MEDIUM");
  });

  it("returns HIGH coupling", () => {
    const result = calculateArchitectureCouplingScore({
      nodeCount: 10,
      edgeCount: 90,
      density: 0.9,
    });

    expect(result.level).toBe("HIGH");
  });
});