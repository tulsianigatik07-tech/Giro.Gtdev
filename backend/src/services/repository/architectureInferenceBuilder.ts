import type { RepositoryArchitectureInference } from "./architectureInferenceTypes.js";
import type { ArchitectureLayerMatch } from "./architectureLayerDetectorTypes.js";
import type { ArchitectureComponentMatch } from "./architectureComponentTypes.js";
import type { ArchitectureRelationMatch } from "./architectureRelationTypes.js";

export function buildRepositoryArchitectureInference(
  repositoryId: string,
  layerMatches: readonly ArchitectureLayerMatch[],
  componentMatches: readonly ArchitectureComponentMatch[],
  relationMatches: readonly ArchitectureRelationMatch[],
): RepositoryArchitectureInference {
  return {
    repositoryId,
    layers: layerMatches.map((match) => ({
      id: match.layerName,
      name: match.layerName,
      filePatterns: [match.filePath],
      responsibilities: [],
    })),
    components: componentMatches.map((match) => ({
      id: match.componentName,
      name: match.componentName,
      layerId: "",
      filePaths: [match.filePath],
      symbols: [],
      responsibilities: [],
    })),
    relations: relationMatches.map((match) => ({
      fromComponentId: match.sourceComponent,
      toComponentId: match.targetComponent,
      relationType: match.relationKind,
      evidenceFiles: [],
    })),
    confidence: "medium",
  };
}