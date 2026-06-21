import type {
    ArchitectureQualitySummary,
  } from "./architectureQualitySummary.js";
  
  export function generateArchitectureRecommendations(
    summary: ArchitectureQualitySummary,
  ): string[] {
    const recommendations: string[] = [];
  
    if (summary.riskLevel === "HIGH") {
      recommendations.push(
        "Reduce coupling between internal modules",
      );
  
      recommendations.push(
        "Break large dependency chains into smaller components",
      );
    }
  
    if (summary.riskLevel === "MEDIUM") {
      recommendations.push(
        "Review module boundaries for tighter separation",
      );
    }
  
    if (summary.riskLevel === "LOW") {
      recommendations.push(
        "Maintain current architectural structure",
      );
    }
  
    return recommendations;
  }