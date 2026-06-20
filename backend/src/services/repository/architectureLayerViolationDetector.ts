import type {
    ArchitectureDependency,
  } from "./architectureDependencyGraph.js";
  
  export interface ArchitectureLayerViolation {
    source: string;
    target: string;
    reason: string;
  }
  
  export function detectLayerViolations(
    dependencies: readonly ArchitectureDependency[],
  ): readonly ArchitectureLayerViolation[] {
    const violations: ArchitectureLayerViolation[] = [];
  
    for (const dependency of dependencies) {
      const source = dependency.source.toLowerCase();
      const target = dependency.target.toLowerCase();
  
      const sourceIsController = source.includes("controller");
      const targetIsRepository = target.includes("repository");
  
      if (sourceIsController && targetIsRepository) {
        violations.push({
          source: dependency.source,
          target: dependency.target,
          reason: "Controller directly depends on repository",
        });
      }
    }
  
    return violations;
  }
  