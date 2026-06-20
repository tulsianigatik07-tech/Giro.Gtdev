import { detectArchitectureLayers } from "./architectureLayerDetector.js";
import type {
  ArchitectureLayerDetectionResult,
  ArchitectureLayerRule,
} from "./architectureLayerDetectorTypes.js";

export function analyzeArchitectureLayers(
  repositoryId: string,
  files: readonly string[],
  rules: readonly ArchitectureLayerRule[],
): ArchitectureLayerDetectionResult {
  return detectArchitectureLayers(
    repositoryId,
    files,
    rules,
  );
}