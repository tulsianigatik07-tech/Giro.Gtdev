import { describe, expect, it } from "vitest";

import { buildArchitectureInput } from "../services/repository/architecturePipeline.js";
import type { TrustedRepositoryCheckoutPath } from "../services/security/repositoryPaths.js";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("architecture pipeline", () => {
  it("builds architecture input from repository path", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "giro-architecture-pipeline-"));
    writeFileSync(path.join(fixture, "index.ts"), "export const value = 1;\n");
    const result = buildArchitectureInput(path.resolve(fixture) as TrustedRepositoryCheckoutPath);
    rmSync(fixture, { recursive: true, force: true });

    expect(Array.isArray(result.files)).toBe(true);
    expect(Array.isArray(result.ignored)).toBe(true);
  });
});
