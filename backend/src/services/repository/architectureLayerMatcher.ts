import type {
    ArchitectureLayerRule,
    ArchitectureLayerMatch,
  } from "./architectureLayerDetectorTypes.js";
  
  export function matchFileToLayer(
    filePath: string,
    rules: readonly ArchitectureLayerRule[],
  ): ArchitectureLayerMatch | null {
    for (const rule of rules) {
      const matched = rule.filePatterns.some((pattern) => {
        const normalized = pattern.replace("/**", "");
        return filePath.startsWith(normalized);
      });
  
      if (matched) {
        return {
          filePath,
          layerName: rule.layerName,
          confidence: 1,
        };
      }
    }
  
    return null;
  }