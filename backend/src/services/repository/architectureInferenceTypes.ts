export type ArchitectureRelationType = "imports" | "calls" | "depends_on" | "unknown";

export type ArchitectureConfidence = "low" | "medium" | "high";

export interface ArchitectureLayer {
  id: string;
  name: string;
  filePatterns: string[];
  responsibilities: string[];
}

export interface ArchitectureComponent {
  id: string;
  name: string;
  layerId: string;
  filePaths: string[];
  symbols: string[];
  responsibilities: string[];
}

export interface ArchitectureRelation {
  fromComponentId: string;
  toComponentId: string;
  relationType: ArchitectureRelationType;
  evidenceFiles: string[];
}

export interface RepositoryArchitectureInference {
  repositoryId: string;
  layers: ArchitectureLayer[];
  components: ArchitectureComponent[];
  relations: ArchitectureRelation[];
  confidence: ArchitectureConfidence;
}