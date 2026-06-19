import type { ArchitectureLayerRule } from "./architectureLayerDetectorTypes.js";

export const DEFAULT_ARCHITECTURE_LAYER_RULES: readonly ArchitectureLayerRule[] = [
  {
    layerName: "routes",
    filePatterns: ["src/routes/**"],
  },
  {
    layerName: "services",
    filePatterns: ["src/services/**"],
  },
  {
    layerName: "middleware",
    filePatterns: ["src/middleware/**"],
  },
  {
    layerName: "config",
    filePatterns: ["src/config/**"],
  },
  {
    layerName: "tests",
    filePatterns: ["src/tests/**", "tests/**"],
  },
];