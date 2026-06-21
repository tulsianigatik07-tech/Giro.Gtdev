import type {
    ArchitectureCouplingScore,
  } from "./architectureCouplingScore.js";
  
  export type ArchitectureRiskLevel = "LOW" | "MEDIUM" | "HIGH";
  
  export interface ArchitectureRiskAssessment {
    level: ArchitectureRiskLevel;
    reason: string;
  }
  
  export function assessArchitectureRisk(
    coupling: ArchitectureCouplingScore,
  ): ArchitectureRiskAssessment {
    if (coupling.level === "HIGH") {
      return {
        level: "HIGH",
        reason: "High coupling detected across internal dependencies",
      };
    }
  
    if (coupling.level === "MEDIUM") {
      return {
        level: "MEDIUM",
        reason: "Moderate coupling detected across internal dependencies",
      };
    }
  
    return {
      level: "LOW",
      reason: "Internal dependency coupling is within a healthy range",
    };
  }