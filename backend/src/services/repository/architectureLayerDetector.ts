import type {
    ArchitectureLayerDetectionResult,
    ArchitectureLayerRule,
  } from "./architectureLayerDetectorTypes.js";
  import { matchFileToLayer } from "./architectureLayerMatcher.js";
  
  export function detectArchitectureLayers(
    repositoryId: string,
    filePaths: readonly string[],
    rules: readonly ArchitectureLayerRule[],
  ): ArchitectureLayerDetectionResult {
    const matches = filePaths
      .map((filePath) => matchFileToLayer(filePath, rules))
      .filter((match) => match !== null);
  
    return {
      repositoryId,
      matches,
    };
  }