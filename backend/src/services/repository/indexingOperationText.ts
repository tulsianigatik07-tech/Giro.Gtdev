import type { IndexingOperation } from "./indexingOperationStore.js";

export function buildIndexingOperationText(
  operation: IndexingOperation,
): string {
  const completed = operation.completedSteps.length;
  const total = operation.totalSteps.length;

  return [
    `Repository: ${operation.repoId}`,
    `Status: ${operation.status}`,
    `Progress: ${completed}/${total} steps completed`,
  ].join("\n");
}