import type {
    ArchitectureInternalDependencyGraph,
  } from "./architectureInternalDependencyGraph.js";
  
  export interface ArchitectureDependencyDensity {
    nodeCount: number;
    edgeCount: number;
    density: number;
  }
  
  export function calculateArchitectureDependencyDensity(
    graph: ArchitectureInternalDependencyGraph,
  ): ArchitectureDependencyDensity {
    const nodeCount = graph.nodes.length;
    const edgeCount = graph.edges.length;
  
    const density =
      nodeCount <= 1
        ? 0
        : edgeCount / (nodeCount * (nodeCount - 1));
  
    return {
      nodeCount,
      edgeCount,
      density,
    };
  }