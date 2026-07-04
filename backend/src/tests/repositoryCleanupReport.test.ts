import { describe, expect, it } from "vitest";

import type {
  RepositoryCleanupExecutionReport,
} from "../services/repository/repositoryCleanupExecutor.js";
import {
  buildRepositoryCleanupReport,
} from "../services/repository/repositoryCleanupReport.js";

function execution(
  input: Partial<RepositoryCleanupExecutionReport> = {},
): RepositoryCleanupExecutionReport {
  const executedResourceIdentifiers =
    input.executedResourceIdentifiers ?? [];
  const skippedResourceIdentifiers =
    input.skippedResourceIdentifiers ?? [];

  return {
    repositoryId: input.repositoryId ?? "acme/demo",
    executedResourceIdentifiers,
    skippedResourceIdentifiers,
    totalExecuted: input.totalExecuted ?? executedResourceIdentifiers.length,
    totalSkipped: input.totalSkipped ?? skippedResourceIdentifiers.length,
  };
}

describe("repository cleanup report", () => {
  it("builds an empty cleanup report", () => {
    const report = buildRepositoryCleanupReport(execution());

    expect(report).toEqual({
      repositoryId: "acme/demo",
      success: true,
      summary: {
        totalExecuted: 0,
        totalSkipped: 0,
      },
      executedResources: [],
      skippedResources: [],
      warnings: [],
      statistics: {
        executionCoverage: 1,
        unsupportedResources: 0,
        completionPercentage: 100,
      },
    });
  });

  it("builds a successful cleanup report", () => {
    const report = buildRepositoryCleanupReport(
      execution({
        executedResourceIdentifiers: [
          "symbolRecords:src/a.ts:1:1:function:alpha",
          "repositoryMetadata:acme/demo",
        ],
      }),
    );

    expect(report.success).toBe(true);
    expect(report.summary).toEqual({
      totalExecuted: 2,
      totalSkipped: 0,
    });
    expect(report.executedResources).toEqual([
      "repositoryMetadata:acme/demo",
      "symbolRecords:src/a.ts:1:1:function:alpha",
    ]);
    expect(report.warnings).toEqual([]);
    expect(report.statistics).toEqual({
      executionCoverage: 1,
      unsupportedResources: 0,
      completionPercentage: 100,
    });
  });

  it("builds a mixed executed and skipped cleanup report", () => {
    const report = buildRepositoryCleanupReport(
      execution({
        executedResourceIdentifiers: [
          "repositoryMetadata:acme/demo",
          "fileSnapshots:src/a.ts",
        ],
        skippedResourceIdentifiers: [
          "cachedRetrievalArtifacts:unsupported",
          "ownership:missing-remove-helper",
        ],
      }),
    );

    expect(report.success).toBe(false);
    expect(report.summary).toEqual({
      totalExecuted: 2,
      totalSkipped: 2,
    });
    expect(report.skippedResources).toEqual([
      "cachedRetrievalArtifacts:unsupported",
      "ownership:missing-remove-helper",
    ]);
    expect(report.warnings).toEqual([
      "Skipped unsupported cleanup resource: cachedRetrievalArtifacts:unsupported",
      "Skipped cleanup resource: ownership:missing-remove-helper",
    ]);
    expect(report.statistics.unsupportedResources).toBe(1);
  });

  it("calculates completion percentage", () => {
    const report = buildRepositoryCleanupReport(
      execution({
        executedResourceIdentifiers: [
          "fileSnapshots:src/a.ts",
          "graphMetadata:src/a.ts",
          "repositoryMetadata:acme/demo",
        ],
        skippedResourceIdentifiers: ["cachedRetrievalArtifacts:unsupported"],
      }),
    );

    expect(report.statistics.executionCoverage).toBe(0.75);
    expect(report.statistics.completionPercentage).toBe(75);
  });

  it("orders resources deterministically", () => {
    const report = buildRepositoryCleanupReport(
      execution({
        executedResourceIdentifiers: [
          "symbolRecords:src/z.ts:5:5:function:zeta",
          "fileSnapshots:src/z.ts",
          "fileSnapshots:src/a.ts",
          "repositoryMetadata:acme/demo",
          "fileSnapshots:src/a.ts",
        ],
        skippedResourceIdentifiers: [
          "ownership:missing-remove-helper",
          "cachedRetrievalArtifacts:unsupported",
          "ownership:missing-remove-helper",
        ],
      }),
    );

    expect(report.executedResources).toEqual([
      "fileSnapshots:src/a.ts",
      "fileSnapshots:src/z.ts",
      "repositoryMetadata:acme/demo",
      "symbolRecords:src/z.ts:5:5:function:zeta",
    ]);
    expect(report.skippedResources).toEqual([
      "cachedRetrievalArtifacts:unsupported",
      "ownership:missing-remove-helper",
    ]);
  });

  it("does not allow returned report mutations to mutate executor state", () => {
    const input = execution({
      executedResourceIdentifiers: ["repositoryMetadata:acme/demo"],
      skippedResourceIdentifiers: ["cachedRetrievalArtifacts:unsupported"],
    });
    const before = structuredClone(input);

    const report = buildRepositoryCleanupReport(input);
    report.executedResources.push("mutated");
    report.skippedResources.push("mutated");
    report.warnings.push("mutated");
    report.summary.totalExecuted = 100;
    report.statistics.completionPercentage = 0;

    expect(input).toEqual(before);

    const rebuilt = buildRepositoryCleanupReport(input);
    expect(rebuilt.executedResources).toEqual([
      "repositoryMetadata:acme/demo",
    ]);
    expect(rebuilt.skippedResources).toEqual([
      "cachedRetrievalArtifacts:unsupported",
    ]);
    expect(rebuilt.summary.totalExecuted).toBe(1);
    expect(rebuilt.statistics.completionPercentage).toBe(50);
  });
});
