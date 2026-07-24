import type { ExecutionWorkUnit, WorkUnitState } from "./types.js";

export function criticalPath(units: readonly ExecutionWorkUnit[]): string[] {
  const byId = new Map(units.map((unit) => [unit.workUnitId, unit]));
  const memo = new Map<string, string[]>();
  const visit = (id: string): string[] => {
    const cached = memo.get(id);
    if (cached) return cached;
    const unit = byId.get(id);
    if (!unit) return [];
    const prefix = unit.prerequisites.map(visit)
      .sort((left, right) => right.length - left.length || left.join().localeCompare(right.join()))[0] ?? [];
    const path = [...prefix, id];
    memo.set(id, path);
    return path;
  };
  return units.map((unit) => visit(unit.workUnitId))
    .sort((left, right) => right.length - left.length || left.join().localeCompare(right.join()))[0] ?? [];
}

export function scheduleWorkUnits(units: readonly WorkUnitState[]): WorkUnitState[] {
  const states = new Map(units.map((unit) => [unit.workUnitId, unit.status]));
  return units.map((unit) => {
    if (!["blocked", "ready"].includes(unit.status)) return unit;
    const predecessorStates = unit.prerequisites.map((id) => states.get(id));
    const failed = predecessorStates.some((status) =>
      status === "failed" || status === "cancelled");
    const complete = predecessorStates.every((status) =>
      status === "succeeded" || status === "skipped");
    return {
      ...unit,
      status: failed ? "blocked" : complete ? "ready" : "blocked",
    };
  });
}

export function independentWork(units: readonly ExecutionWorkUnit[]): string[][] {
  const remaining = new Map(units.map((unit) => [unit.workUnitId, new Set(unit.prerequisites)]));
  const levels: string[][] = [];
  const completed = new Set<string>();
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => [...dependencies].every((id) => completed.has(id)))
      .map(([id]) => id)
      .sort();
    if (ready.length === 0) throw new Error("execution_dependency_cycle");
    levels.push(ready);
    for (const id of ready) {
      completed.add(id);
      remaining.delete(id);
    }
  }
  return levels;
}
