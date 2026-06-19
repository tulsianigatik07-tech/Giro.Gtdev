import type { ArchitectureComponentRule } from "./architectureComponentTypes.js";

export const DEFAULT_ARCHITECTURE_COMPONENT_RULES: readonly ArchitectureComponentRule[] = [
  {
    componentName: "authentication",
    filePatterns: ["src/auth/**"],
  },
  {
    componentName: "repository",
    filePatterns: ["src/services/repository/**"],
  },
  {
    componentName: "retrieval",
    filePatterns: ["src/services/retrieval/**"],
  },
  {
    componentName: "indexing",
    filePatterns: ["src/services/indexing/**"],
  },
  {
    componentName: "graph",
    filePatterns: ["src/services/graph/**"],
  },
];