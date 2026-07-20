import { describe, expect, it } from "vitest";

import { runArchitectureEngine } from "../services/repository/architectureEngine.js";
import type { TrustedRepositoryCheckoutPath } from "../services/security/repositoryPaths.js";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("architecture engine", () => {
  it("runs architecture inference for a repository path", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "giro-architecture-engine-"));
    writeFileSync(path.join(fixture, "index.ts"), "export const value = 1;\n");
    const result = runArchitectureEngine("demo/repo", path.resolve(fixture) as TrustedRepositoryCheckoutPath);
    rmSync(fixture, { recursive: true, force: true });

    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });
});
