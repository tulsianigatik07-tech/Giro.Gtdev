export interface ArchitectureLayerConfig {
    layerName: string;
    filePatterns: string[];
  }
  
  export interface ArchitectureInferenceConfig {
    repositoryId: string;
    maxComponentsPerLayer: number;
    includeExternalDependencies: boolean;
    layers: ArchitectureLayerConfig[];
  }