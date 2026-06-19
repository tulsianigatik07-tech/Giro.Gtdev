export interface ArchitectureClassificationRule {
    layerName: string;
    patterns: readonly string[];
    priority: number;
  }
  
  export const DEFAULT_ARCHITECTURE_CLASSIFICATION_RULES: readonly ArchitectureClassificationRule[] = [
    {
      layerName: "routes",
      patterns: ["src/routes/**"],
      priority: 100,
    },
    {
      layerName: "services",
      patterns: ["src/services/**"],
      priority: 90,
    },
    {
      layerName: "middleware",
      patterns: ["src/middleware/**"],
      priority: 80,
    },
    {
      layerName: "config",
      patterns: ["src/config/**"],
      priority: 70,
    },
    {
      layerName: "tests",
      patterns: ["src/tests/**", "tests/**"],
      priority: 60,
    },
  ];