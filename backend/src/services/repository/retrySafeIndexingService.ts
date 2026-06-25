import {
  getIndexingOperation,
  markStepCompleted,
  markOperationFailed,
  markOperationCompleted,
} from "./indexingOperationStore.js";

export interface RetrySafeExecutionPlan {
  resumable: boolean;
  remainingSteps: string[];
  completedSteps: string[];
}

export interface RetrySafeExecutionResult {
  repoId: string;
  status: "not_found" | "completed" | "failed";
  attemptedSteps: string[];
  completedSteps: string[];
  failedStep: string | null;
}

export function planRetrySafeExecution(repoId: string): RetrySafeExecutionPlan {
  const op = getIndexingOperation(repoId);
  const resumable = op !== null && (op.status === "running" || op.status === "failed");

  if (!op || !resumable) {
    return { resumable: false, remainingSteps: [], completedSteps: [] };
  }

  const completed = new Set(op.completedSteps);
  const remainingSteps = op.totalSteps.filter((s) => !completed.has(s));

  return { resumable: true, remainingSteps, completedSteps: [...op.completedSteps] };
}

export function executeRetrySafeIndexing(
  repoId: string,
  runStep: (step: string) => void,
): RetrySafeExecutionResult {
  const op = getIndexingOperation(repoId);

  if (!op) {
    return {
      repoId,
      status: "not_found",
      attemptedSteps: [],
      completedSteps: [],
      failedStep: null,
    };
  }

  const completed = new Set(op.completedSteps);
  const remaining = op.totalSteps.filter((s) => !completed.has(s));
  const attemptedSteps: string[] = [];

  for (const step of remaining) {
    attemptedSteps.push(step);

    try {
      runStep(step);
    } catch {
      markOperationFailed(repoId);

      return {
        repoId,
        status: "failed",
        attemptedSteps,
        completedSteps: [...completed],
        failedStep: step,
      };
    }

    markStepCompleted(repoId, step);
    completed.add(step);
  }

  markOperationCompleted(repoId);

  return {
    repoId,
    status: "completed",
    attemptedSteps,
    completedSteps: [...completed],
    failedStep: null,
  };
}