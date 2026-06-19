import type {
    ArchitectureRelationKind,
    ArchitectureRelationMatch,
  } from "./architectureRelationTypes.js";
  
  export function matchComponentRelation(
    sourceComponent: string,
    targetComponent: string,
    relationKind: ArchitectureRelationKind,
  ): ArchitectureRelationMatch | null {
    if (sourceComponent === targetComponent) {
      return null;
    }
  
    return {
      sourceComponent,
      targetComponent,
      relationKind,
      confidence: 1,
    };
  }