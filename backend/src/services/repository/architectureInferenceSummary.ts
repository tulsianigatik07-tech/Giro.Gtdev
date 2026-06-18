export interface ArchitectureLayerSummary {
    layerName: string;
    componentCount: number;
  }
  
  export interface ArchitectureRelationSummary {
    relationType: string;
    count: number;
  }
  
  export interface ArchitectureInferenceSummary {
    repositoryId: string;
    totalLayers: number;
    totalComponents: number;
    totalRelations: number;
    layers: ArchitectureLayerSummary[];
    relations: ArchitectureRelationSummary[];
  }