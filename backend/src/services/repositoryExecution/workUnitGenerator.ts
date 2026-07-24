import type { RepositoryPlanRecord } from "../repositoryPlanning/types.js";
import { stableHash, stableId } from "./determinism.js";
import type {
  ExecutionPolicy,
  ExecutionWorkUnit,
} from "./types.js";

const FORBIDDEN_OPERATIONS = Object.freeze([
  "apply_repository_changes",
  "execute_arbitrary_shell_commands",
  "commit_changes",
  "push_changes",
  "merge_changes",
]);

function phaseRisk(plan: RepositoryPlanRecord, fileCount: number, publicSymbols: number): number {
  const base = plan.riskAnalysis.overallRisk;
  const breadth = Math.min(1, fileCount / Math.max(1, plan.affectedFiles.length));
  const api = Math.min(1, publicSymbols / 3);
  return Number(Math.min(1, base * 0.65 + breadth * 0.2 + api * 0.15).toFixed(4));
}

export function generateExecutionWorkUnits(
  plan: RepositoryPlanRecord,
  policy: ExecutionPolicy,
  maxAttempts: number,
): ExecutionWorkUnit[] {
  const phaseToUnit = new Map<string, string>();
  for (const phase of [...plan.implementationPhases].sort((a, b) =>
    a.order - b.order || a.phaseId.localeCompare(b.phaseId))) {
    phaseToUnit.set(phase.phaseId, stableId("wu", {
      planVersion: plan.planVersion,
      policy,
      phaseId: phase.phaseId,
    }));
  }

  const units = [...plan.implementationPhases]
    .sort((a, b) => a.order - b.order || a.phaseId.localeCompare(b.phaseId))
    .map((phase, index): ExecutionWorkUnit => {
      const files = [...new Set(phase.files)].sort();
      const symbols = [...new Set(phase.symbols)].sort();
      const publicSymbols = plan.affectedSymbols.filter((symbol) =>
        symbol.publicApi && symbols.includes(symbol.nodeId)).length;
      const prerequisites = phase.dependsOn
        .map((phaseId) => phaseToUnit.get(phaseId))
        .filter((value): value is string => Boolean(value))
        .sort();
      const validationCommands = plan.validationSteps
        .filter((step) => step.required)
        .map((step) => step.command)
        .filter((command, commandIndex, values) => values.indexOf(command) === commandIndex)
        .sort();
      return {
        workUnitId: phaseToUnit.get(phase.phaseId)!,
        phaseId: phase.phaseId,
        order: index,
        objective: `${phase.name}: ${plan.objective}`,
        affectedFiles: files,
        affectedSymbols: symbols,
        allowedOperations: [
          "inspect_repository_context",
          "propose_changes",
          "propose_validation_commands",
          "publish_structured_output",
        ],
        forbiddenOperations: [...FORBIDDEN_OPERATIONS],
        prerequisites,
        validationCommands,
        expectedOutputs: [
          "structured_change_proposal",
          "structured_test_proposal",
          "risk_and_blocker_report",
        ],
        rollbackInstructions: [...plan.rollbackStrategy.actions].sort(),
        riskScore: phaseRisk(plan, files.length, publicSymbols),
        approvalRequired: policy !== "review_only",
        retryPolicy: {
          maxAttempts,
          retryableFailureCodes: ["agent_unavailable", "lease_expired", "transient_failure"],
        },
        parallelSafe: phase.independentlyExecutable && prerequisites.length === 0,
        criticalPathRank: 0,
      };
    });

  const byId = new Map(units.map((unit) => [unit.workUnitId, unit]));
  const memo = new Map<string, number>();
  const rank = (unitId: string): number => {
    const cached = memo.get(unitId);
    if (cached !== undefined) return cached;
    const unit = byId.get(unitId);
    const value = unit ? 1 + Math.max(0, ...unit.prerequisites.map(rank)) : 0;
    memo.set(unitId, value);
    return value;
  };
  return units.map((unit) => ({ ...unit, criticalPathRank: rank(unit.workUnitId) }));
}

export function executionIdentity(
  plan: RepositoryPlanRecord,
  policy: ExecutionPolicy,
  constraints: Record<string, unknown>,
): { executionId: string; executionVersion: string } {
  const identity = {
    planVersion: plan.planVersion,
    repositoryRevision: plan.repositoryRevision,
    policy,
    constraints,
  };
  return {
    executionId: stableId("exec", identity),
    executionVersion: `execution-${stableHash(identity)}`,
  };
}
