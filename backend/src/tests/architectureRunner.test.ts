import { describe, expect, it } from "vitest";

import { runArchitectureAnalysis } from "../services/repository/architectureRunner.js";
import type { TrustedRepositoryCheckoutPath } from "../services/security/repositoryPaths.js";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("architecture runner", () => {
  it("runs architecture analysis and returns architecture plus report", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "giro-architecture-runner-"));
    writeFileSync(path.join(fixture, "index.ts"), "export const value = 1;\n");
    const result = runArchitectureAnalysis("demo/repo", path.resolve(fixture) as TrustedRepositoryCheckoutPath);
    rmSync(fixture, { recursive: true, force: true });

    expect(result).toHaveProperty("architecture");
    expect(result).toHaveProperty("report");
    expect(result.architecture).toBeDefined();
    expect(result.report).toBeDefined();
  });
});
