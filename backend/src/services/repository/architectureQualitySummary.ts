import type { ArchitectureCouplingScore } from "./architectureCouplingScore.js";
import type { ArchitectureRiskAssessment } from "./architectureRiskLevel.js";

export interface ArchitectureQualitySummary {
  couplingScore: number;
  couplingLevel: ArchitectureCouplingScore["level"];
  riskLevel: ArchitectureRiskAssessment["level"];
  summary: string;
}

export function buildArchitectureQualitySummary(
  coupling: ArchitectureCouplingScore,
  risk: ArchitectureRiskAssessment,
): ArchitectureQualitySummary {
  return {
    couplingScore: coupling.score,
    couplingLevel: coupling.level,
    riskLevel: risk.level,
    summary: risk.reason,
  };
}