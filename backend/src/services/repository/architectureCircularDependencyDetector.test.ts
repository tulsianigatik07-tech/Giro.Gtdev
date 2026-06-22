import { describe, expect, it } from "vitest";

import {
  detectCircularDependencies,
} from "./architectureCircularDependencyDetector.js";

describe("architecture circular dependency detector", () => {
  it("detects circular dependencies", () => {
    const result = detectCircularDependencies([
      {
        source: "auth.ts",
        target: "user.ts",
      },
      {
        source: "user.ts",
        target: "auth.ts",
      },
    ]);

    expect(result.length).toBe(2);
  });

  it("returns empty array when no cycles exist", () => {
    const result = detectCircularDependencies([
      {
        source: "auth.ts",
        target: "user.ts",
      },
    ]);

    expect(result.length).toBe(0);
  });
});