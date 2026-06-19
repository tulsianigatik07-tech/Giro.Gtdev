export interface ArchitectureLayerRule {
    layerName: string;
    filePatterns: readonly string[];
  }
  
  export interface ArchitectureLayerMatch {
    filePath: string;
    layerName: string;
    confidence: number;
  }
  
  export interface ArchitectureLayerDetectionResult {
    repositoryId: string;
    matches: readonly ArchitectureLayerMatch[];
  }