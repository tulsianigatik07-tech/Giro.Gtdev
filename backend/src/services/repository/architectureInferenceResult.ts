export interface ArchitectureInferenceMetadata {
  repositoryId: string;
  generatedAt: string;
  inferenceVersion: string;
}

export interface ArchitectureInferenceStats {
  layerCount: number;
  componentCount: number;
  relationCount: number;
}

export interface ArchitectureInferenceResult {
  metadata: ArchitectureInferenceMetadata;
  stats: ArchitectureInferenceStats;
}