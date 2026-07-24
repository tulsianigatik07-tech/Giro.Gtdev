import type { RepositoryExecutionPlan, PlanRiskAnalysis } from "./types.js";

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const ratio = (value: number, maximum: number) => maximum > 0 ? clamp(value / maximum) : 0;

export function scorePlanRisk(input: {
  affectedFileCount: number;
  repositoryFileCount: number;
  affectedSubsystemCount: number;
  repositorySubsystemCount: number;
  dependencyCount: number;
  circularPlanCount: number;
  publicApiCount: number;
  migrationRequired: boolean;
  phaseCount: number;
  validationCount: number;
}): PlanRiskAnalysis {
  const architecturalRisk = clamp(
    ratio(input.affectedSubsystemCount, input.repositorySubsystemCount) * 0.7 +
    ratio(input.circularPlanCount, 3) * 0.3,
  );
  const dependencyRisk = clamp(
    ratio(input.dependencyCount, Math.max(1, input.affectedFileCount * 2)) * 0.75 +
    ratio(input.circularPlanCount, 2) * 0.25,
  );
  const blastRadius = ratio(input.affectedFileCount, input.repositoryFileCount);
  const publicApiImpact = ratio(input.publicApiCount, Math.max(1, input.affectedFileCount));
  const migrationImpact = input.migrationRequired ? 1 : 0;
  const testingComplexity = clamp(
    ratio(input.phaseCount, 8) * 0.45 +
    ratio(input.dependencyCount, 20) * 0.35 +
    (input.validationCount < input.phaseCount ? 0.2 : 0),
  );
  const components = [
    architecturalRisk,
    dependencyRisk,
    blastRadius,
    publicApiImpact,
    migrationImpact,
    testingComplexity,
  ];
  const overallRisk = clamp(components.reduce((sum, value) => sum + value, 0) / components.length);
  const level: PlanRiskAnalysis["level"] =
    overallRisk >= 0.75 ? "critical" :
    overallRisk >= 0.5 ? "high" :
    overallRisk >= 0.25 ? "medium" : "low";
  return {
    architecturalRisk,
    dependencyRisk,
    blastRadius,
    publicApiImpact,
    migrationImpact,
    testingComplexity,
    overallRisk,
    level,
  };
}

export function riskValuesConsistent(risk: RepositoryExecutionPlan["riskAnalysis"]): boolean {
  const values = [
    risk.architecturalRisk,
    risk.dependencyRisk,
    risk.blastRadius,
    risk.publicApiImpact,
    risk.migrationImpact,
    risk.testingComplexity,
    risk.overallRisk,
  ];
  return values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
}
