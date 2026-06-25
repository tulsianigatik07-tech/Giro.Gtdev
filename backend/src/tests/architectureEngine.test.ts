import { describe, expect, it } from "vitest";

import { runArchitectureEngine } from "../services/repository/architectureEngine.js";

describe("architecture engine", () => {
  it("runs architecture inference for a repository path", () => {
    const result = runArchitectureEngine("demo/repo", ".");

    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });
});