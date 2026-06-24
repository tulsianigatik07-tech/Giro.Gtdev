import { describe, expect, it } from "vitest";

import type { IndexingOperation } from "../services/repository/indexingOperationStore.js";
import { summarizeIndexingOperations } from "../services/repository/indexingOperationSummary.js";

function operation(status: IndexingOperation["status"]): IndexingOperation {
  return {
    repoId: `demo/${status}`,
    status,
    totalSteps: ["clone", "scan", "index"],
    completedSteps: status === "completed" ? ["clone", "scan", "index"] : [],
  };
}

describe("indexing operation summary", () => {
  it("summarizes operation statuses", () => {
    const result = summarizeIndexingOperations([
      operation("pending"),
      operation("running"),
      operation("completed"),
      operation("failed"),
      operation("completed"),
    ]);

    expect(result).toEqual({
      total: 5,
      pending: 1,
      running: 1,
      completed: 2,
      failed: 1,
    });
  });

  it("returns zero counts for empty input", () => {
    expect(summarizeIndexingOperations([])).toEqual({
      total: 0,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
    });
  });
});