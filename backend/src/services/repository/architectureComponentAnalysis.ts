import { detectArchitectureComponents } from "./architectureComponentDetector.js";
import type {
  ArchitectureComponentDetectionResult,
  ArchitectureComponentRule,
} from "./architectureComponentTypes.js";

export function analyzeArchitectureComponents(
  repositoryId: string,
  files: readonly string[],
  rules: readonly ArchitectureComponentRule[],
): ArchitectureComponentDetectionResult {
  return detectArchitectureComponents(
    repositoryId,
    files,
    rules,
  );
}