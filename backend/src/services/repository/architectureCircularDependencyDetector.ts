import type {
    ArchitectureDependency,
  } from "./architectureDependencyGraph.js";
  
  export interface CircularDependency {
    source: string;
    target: string;
  }
  
  export function detectCircularDependencies(
    dependencies: readonly ArchitectureDependency[],
  ): readonly CircularDependency[] {
    const circular: CircularDependency[] = [];
  
    for (const dependency of dependencies) {
      const reverse = dependencies.find(
        (candidate) =>
          candidate.source === dependency.target &&
          candidate.target === dependency.source,
      );
  
      if (reverse) {
        circular.push({
          source: dependency.source,
          target: dependency.target,
        });
      }
    }
  
    return circular;
  }