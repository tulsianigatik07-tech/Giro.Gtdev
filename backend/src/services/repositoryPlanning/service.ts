import { env } from "../../config/env.js";
import { runtimeMetrics } from "../../observability/metrics.js";
import { buildRepositoryPlan } from "./planner.js";
import type { RepositoryPlanningStore } from "./store.js";
import { runtimeRepositoryPlanningStore } from "./store.js";
import type { RepositoryPlanningInput } from "./types.js";
import { createRepositoryPlanIdentity, deterministicTaskHash } from "./version.js";

export class RepositoryPlanningService {
  constructor(private readonly store: RepositoryPlanningStore = runtimeRepositoryPlanningStore) {}

  async createPlan(input: RepositoryPlanningInput, signal?: AbortSignal) {
    const startedAt = performance.now();
    const identity = createRepositoryPlanIdentity(input);
    const began = await this.store.begin(identity, signal);
    if (began.alreadyPublished) {
      const published = await this.store.loadPublished(input.repositoryId, identity.taskHash, signal);
      if (!published) throw new Error("Published repository plan is unavailable.");
      return published;
    }
    try {
      signal?.throwIfAborted();
      const plan = buildRepositoryPlan(input);
      if (performance.now() - startedAt > env.REPOSITORY_PLAN_MAX_DURATION_MS) {
        throw new Error("Repository planning duration exceeded.");
      }
      await this.store.stage(plan, {
        knownFiles: [...new Set(input.graph.nodes.map((node) => node.file).filter(Boolean))].sort(),
        knownNodeIds: [...new Set(input.graph.nodes.map((node) => node.nodeId))].sort(),
      }, signal);
      await this.store.validate(plan.planVersion, signal);
      await this.store.publish(plan.planVersion, signal);
      const durationMs = performance.now() - startedAt;
      runtimeMetrics.recordRepositoryPlanning({
        durationMs,
        phaseCount: plan.implementationPhases.length,
        dependencyCount: plan.dependencyOrder.dependencies.length,
        riskScore: plan.riskAnalysis.overallRisk,
        retrievalContribution: plan.retrievalContribution.affectedFileCount,
      });
      const published = await this.store.loadPublished(plan.repositoryId, plan.taskHash, signal);
      if (!published) throw new Error("Repository plan publication is unavailable.");
      return published;
    } catch (error) {
      await this.store.fail(identity.planVersion, [{
        code: "planner_failed",
        message: error instanceof Error ? error.message : "Repository planning failed.",
      }], signal).catch(() => undefined);
      runtimeMetrics.incrementRepositoryPlannerFailures();
      throw error;
    }
  }

  async getPublishedPlan(repositoryId: string, userTask: string, signal?: AbortSignal) {
    return this.store.loadPublished(repositoryId, deterministicTaskHash(userTask), signal);
  }
}

export const runtimeRepositoryPlanningService = new RepositoryPlanningService();
