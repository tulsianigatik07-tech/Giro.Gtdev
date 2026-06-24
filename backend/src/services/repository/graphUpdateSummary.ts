import type { GraphUpdatePlan } from "./graphUpdatePlanner.js";

export interface GraphUpdateSummary {
  addedCount: number;
  refreshedCount: number;
  removedCount: number;
  affectedFileCount: number;
  edgeRefreshCount: number;
  requiresGraphRebuild: boolean;
}

export function summarizeGraphUpdatePlan(
  plan: GraphUpdatePlan,
): GraphUpdateSummary {
  const changedNodeCount =
    plan.nodesToAdd.length + plan.nodesToRefresh.length + plan.nodesToRemove.length;

  return {
    addedCount: plan.nodesToAdd.length,
    refreshedCount: plan.nodesToRefresh.length,
    removedCount: plan.nodesToRemove.length,
    affectedFileCount: plan.affectedFiles.length,
    edgeRefreshCount: plan.edgesToRefresh.length,
    requiresGraphRebuild: changedNodeCount > 0,
  };
}