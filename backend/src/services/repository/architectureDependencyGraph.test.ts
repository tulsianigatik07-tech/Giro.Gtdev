import { describe, expect, it } from "vitest";

import { buildDependencyGraph } from "../graph/graphBuilder.js";

describe("architecture dependency graph", () => {
  it("creates graph structure", () => {
    const result = buildDependencyGraph([]);

    expect(result).toBeDefined();
    expect(result.edges).toBeDefined();
  });

  it("returns empty graph for empty input", () => {
    const result = buildDependencyGraph([]);

    expect(result.edges.length).toBe(0);
  });
});