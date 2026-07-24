import { Buffer } from "node:buffer";
import type {
  AgentWorkUnitOutput,
  ExecutionRun,
  ExecutionWorkUnit,
} from "./types.js";
import { ExecutionOrchestratorError } from "./types.js";

export function validateWorkUnits(units: readonly ExecutionWorkUnit[]): void {
  const ids = new Set(units.map((unit) => unit.workUnitId));
  if (ids.size !== units.length) throw new ExecutionOrchestratorError("duplicate_work_unit", "Duplicate work-unit ID.");
  for (const unit of units) {
    if (unit.prerequisites.includes(unit.workUnitId)) {
      throw new ExecutionOrchestratorError("execution_dependency_cycle", "A work unit depends on itself.");
    }
    if (unit.prerequisites.some((id) => !ids.has(id))) {
      throw new ExecutionOrchestratorError("missing_prerequisite", "A prerequisite does not exist.");
    }
    if (unit.riskScore < 0 || unit.riskScore > 1) {
      throw new ExecutionOrchestratorError("invalid_risk", "Work-unit risk must be between zero and one.");
    }
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const byId = new Map(units.map((unit) => [unit.workUnitId, unit]));
  const visit = (id: string) => {
    if (active.has(id)) throw new ExecutionOrchestratorError("execution_dependency_cycle", "Work-unit graph is cyclic.");
    if (visited.has(id)) return;
    active.add(id);
    for (const dependency of byId.get(id)?.prerequisites ?? []) visit(dependency);
    active.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

export function validateAgentOutput(output: AgentWorkUnitOutput, maxBytes: number): void {
  if (!output || typeof output !== "object" || !output.summary?.trim() ||
      !Array.isArray(output.filesConsidered) || !Array.isArray(output.proposedChanges) ||
      !Array.isArray(output.commandsProposed) || !Array.isArray(output.testsProposed) ||
      !Array.isArray(output.risksDiscovered) || !Array.isArray(output.blockers) ||
      !Array.isArray(output.artifacts) ||
      !["completed", "blocked", "failed"].includes(output.completionStatus)) {
    throw new ExecutionOrchestratorError("invalid_agent_output", "A complete structured agent output is required.");
  }
  if (Buffer.byteLength(JSON.stringify(output)) > maxBytes) {
    throw new ExecutionOrchestratorError("execution_output_quota_exceeded", "Agent output exceeds the configured size limit.", {
      limit: maxBytes,
    });
  }
}

export function verifyExecutionIntegrity(run: ExecutionRun): void {
  validateWorkUnits(run.workUnits);
  const unitIds = new Set(run.workUnits.map((unit) => unit.workUnitId));
  if (run.leases.some((lease) => !unitIds.has(lease.workUnitId)) ||
      run.outputs.some((output) => !unitIds.has(output.workUnitId)) ||
      run.reviews.some((review) => !unitIds.has(review.workUnitId))) {
    throw new ExecutionOrchestratorError("execution_integrity_invalid", "Execution contains orphan work-unit references.");
  }
}
