export interface ArchitectureComponentRule {
    componentName: string;
    filePatterns: readonly string[];
  }
  
  export interface ArchitectureComponentMatch {
    filePath: string;
    componentName: string;
    confidence: number;
  }
  
  export interface ArchitectureComponentDetectionResult {
    repositoryId: string;
    matches: readonly ArchitectureComponentMatch[];
  }