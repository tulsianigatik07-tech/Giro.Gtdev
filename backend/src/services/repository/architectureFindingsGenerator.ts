import type {
    ArchitectureFinding,
  } from "./architectureFindingTypes.js";
  
  import type {
    ArchitectureQualitySummary,
  } from "./architectureQualitySummary.js";
  
  export function generateArchitectureFindings(
    summary: ArchitectureQualitySummary,
  ): ArchitectureFinding[] {
    const findings: ArchitectureFinding[] = [];
  
    if (summary.riskLevel === "HIGH") {
      findings.push({
        title: "High Internal Coupling",
        severity: "CRITICAL",
        description:
          "Modules have a high level of dependency coupling.",
        recommendation:
          "Reduce direct dependencies and improve separation of concerns.",
      });
    }
  
    if (summary.riskLevel === "MEDIUM") {
      findings.push({
        title: "Moderate Internal Coupling",
        severity: "WARNING",
        description:
          "Some areas of the architecture are becoming tightly coupled.",
        recommendation:
          "Review module boundaries and dependency directions.",
      });
    }
  
    if (summary.riskLevel === "LOW") {
      findings.push({
        title: "Healthy Architecture",
        severity: "INFO",
        description:
          "Dependency structure appears healthy.",
        recommendation:
          "Continue maintaining current architectural practices.",
      });
    }
  
    return findings;
  }