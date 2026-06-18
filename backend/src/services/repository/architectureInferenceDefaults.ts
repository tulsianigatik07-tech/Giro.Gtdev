import type { ArchitectureInferenceConfig } from "./architectureInferenceConfig.js";

export const DEFAULT_ARCHITECTURE_INFERENCE_VERSION = "v1";

export const DEFAULT_MAX_COMPONENTS_PER_LAYER = 20;

export const DEFAULT_ARCHITECTURE_INFERENCE_CONFIG: ArchitectureInferenceConfig = {
  repositoryId: "",
  maxComponentsPerLayer: DEFAULT_MAX_COMPONENTS_PER_LAYER,
  includeExternalDependencies: false,
  layers: [
    {
      layerName: "routes",
      filePatterns: ["src/routes/**", "routes/**"],
    },
    {
      layerName: "services",
      filePatterns: ["src/services/**", "services/**"],
    },
    {
      layerName: "types",
      filePatterns: ["src/types/**", "types/**"],
    },
    {
      layerName: "tests",
      filePatterns: ["src/tests/**", "tests/**"],
    },
  ],
};