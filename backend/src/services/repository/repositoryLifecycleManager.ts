import { buildRepositoryDashboardSummary } from "./repositoryDashboardSummary.js";
import type { RepositoryDashboardSummary } from "./repositoryDashboardSummary.js";
import { executeRepositoryCleanupPlan } from "./repositoryCleanupExecutor.js";
import { buildRepositoryCleanupPlan } from "./repositoryCleanupPlanner.js";
import { buildRepositoryCleanupReport } from "./repositoryCleanupReport.js";
import type { RepositoryCleanupReport } from "./repositoryCleanupReport.js";

export interface RepositoryLifecycleReference {
  owner: string;
  repo: string;
  repoId: string;
}

export interface RepositoryLifecycleInput {
  owner: string;
  repo: string;
}

export interface ConnectRepositoryInput<TIndexResult>
  extends RepositoryLifecycleInput {
  indexRepository: () => Promise<TIndexResult>;
}

export interface ConnectRepositoryResult<TIndexResult> {
  repository: RepositoryLifecycleReference;
  indexResult: TIndexResult;
  summary: RepositoryDashboardSummary;
}

function repositoryReference(
  input: RepositoryLifecycleInput,
): RepositoryLifecycleReference {
  return {
    owner: input.owner,
    repo: input.repo,
    repoId: `${input.owner}/${input.repo}`,
  };
}

export async function connectRepository<TIndexResult>(
  input: ConnectRepositoryInput<TIndexResult>,
): Promise<ConnectRepositoryResult<TIndexResult>> {
  const indexResult = await input.indexRepository();

  return {
    repository: repositoryReference(input),
    indexResult,
    summary: getRepositorySummary(input),
  };
}

export function cleanupRepository(
  input: RepositoryLifecycleInput,
): RepositoryCleanupReport {
  const plan = buildRepositoryCleanupPlan(input.owner, input.repo);
  const execution = executeRepositoryCleanupPlan(plan);
  return buildRepositoryCleanupReport(execution);
}

export function getRepositorySummary(
  input: RepositoryLifecycleInput,
): RepositoryDashboardSummary {
  return buildRepositoryDashboardSummary(input.owner, input.repo);
}
