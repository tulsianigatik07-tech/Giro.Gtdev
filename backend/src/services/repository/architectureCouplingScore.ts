import type {
    ArchitectureDependencyDensity,
  } from "./architectureDependencyDensity.js";
  
  export interface ArchitectureCouplingScore {
    score: number;
    level: "LOW" | "MEDIUM" | "HIGH";
  }
  
  export function calculateArchitectureCouplingScore(
    density: ArchitectureDependencyDensity,
  ): ArchitectureCouplingScore {
    const score = Math.min(
      100,
      Math.round(density.density * 100),
    );
  
    let level: "LOW" | "MEDIUM" | "HIGH";
  
    if (score < 30) {
      level = "LOW";
    } else if (score < 70) {
      level = "MEDIUM";
    } else {
      level = "HIGH";
    }
  
    return {
      score,
      level,
    };
  }