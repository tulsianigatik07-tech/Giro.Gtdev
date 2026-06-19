import type {
    ArchitectureRelationDetectionResult,
    ArchitectureRelationKind,
  } from "./architectureRelationTypes.js";
  
  import { matchComponentRelation } from "./architectureRelationMatcher.js";
  
  export function detectArchitectureRelations(
    repositoryId: string,
    components: readonly string[],
    relationKind: ArchitectureRelationKind,
  ): ArchitectureRelationDetectionResult {
    const matches = [];
  
    for (const source of components) {
      for (const target of components) {
        const match = matchComponentRelation(
          source,
          target,
          relationKind,
        );
  
        if (match) {
          matches.push(match);
        }
      }
    }
  
    return {
      repositoryId,
      matches,
    };
  }