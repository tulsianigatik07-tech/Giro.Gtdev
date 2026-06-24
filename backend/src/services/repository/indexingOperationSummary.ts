import type { IndexingOperation } from "./indexingOperationStore.js";

export interface IndexingOperationSummary {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export function summarizeIndexingOperations(
  operations: readonly IndexingOperation[],
): IndexingOperationSummary {
  const summary: IndexingOperationSummary = {
    total: operations.length,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
  };

  for (const operation of operations) {
    summary[operation.status] += 1;
  }

  return summary;
}