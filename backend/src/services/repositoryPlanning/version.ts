import { createHash } from "node:crypto";
import type { RepositoryPlanIdentity, RepositoryPlanningInput } from "./types.js";
import { REPOSITORY_PLAN_SCHEMA_VERSION, REPOSITORY_PLANNER_VERSION } from "./types.js";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export function normalizePlanningTask(task: string): string {
  return task.trim().replace(/\s+/gu, " ");
}

export function deterministicTaskHash(task: string): string {
  return digest(normalizePlanningTask(task).toLowerCase());
}

export function createRepositoryPlanIdentity(input: RepositoryPlanningInput): RepositoryPlanIdentity {
  const taskHash = deterministicTaskHash(input.userTask);
  const identity = {
    taskHash,
    repositoryId: input.repositoryId,
    repositoryRevision: input.repositoryRevision,
    intelligenceVersion: input.intelligence.intelligenceVersion,
    graphVersion: input.graph.graphVersion,
    embeddingVersion: input.embeddingVersion,
    plannerVersion: REPOSITORY_PLANNER_VERSION,
    schemaVersion: REPOSITORY_PLAN_SCHEMA_VERSION,
  };
  const inputDigest = digest({
    retrievalResults: [...input.retrievalResults].map((result) => ({
      repository: result.repository,
      filePath: result.filePath,
      startLine: result.startLine,
      endLine: result.endLine,
      score: result.score,
      source: result.source,
      symbol: result.symbol ?? null,
      contentHash: digest(result.content),
    })).sort((left, right) =>
      left.filePath.localeCompare(right.filePath) ||
      left.startLine - right.startLine ||
      left.endLine - right.endLine),
    repositoryStatistics: input.repositoryStatistics,
    repositoryHistory: [...input.repositoryHistory].map((record) => stable(record)),
  });
  return {
    ...identity,
    planVersion: `rp-${digest([...Object.values(identity), inputDigest])}`,
  };
}
