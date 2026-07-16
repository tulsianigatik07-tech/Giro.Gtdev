import type { AnalysisResult } from "../repository/analyzer.js";
import type { ScanStats } from "../repository/scanner.js";
import type { DependencyGraph, FileSymbolMap } from "../graph/types.js";

export interface RepositorySummaryItem {
  name: string;
  path?: string;
  kind?: string;
  reason?: string;
}

export interface RepositoryDependencyOverview {
  totalNodes: number;
  totalEdges: number;
  averageInDegree: number;
  averageOutDegree: number;
  centralModules: string[];
  dependencyHotspots: string[];
  isolatedModules: string[];
  circularDependencies: string[][];
}

export interface RepositorySummary {
  repositoryId: string;
  repositoryVersion: string;
  generatedAt: string;
  purpose: string;
  languages: RepositorySummaryItem[];
  frameworks: RepositorySummaryItem[];
  packageManagers: RepositorySummaryItem[];
  applications: RepositorySummaryItem[];
  libraries: RepositorySummaryItem[];
  services: RepositorySummaryItem[];
  modules: RepositorySummaryItem[];
  entrypoints: RepositorySummaryItem[];
  importantDirectories: RepositorySummaryItem[];
  configFiles: RepositorySummaryItem[];
  apiSurface: RepositorySummaryItem[];
  backgroundWorkers: RepositorySummaryItem[];
  dataStores: RepositorySummaryItem[];
  authentication: RepositorySummaryItem[];
  retrieval: RepositorySummaryItem[];
  indexing: RepositorySummaryItem[];
  testing: RepositorySummaryItem[];
  build: RepositorySummaryItem[];
  deployment: RepositorySummaryItem[];
  dependencyOverview: RepositoryDependencyOverview;
}

export interface RepositorySummaryBuildInput {
  repositoryId: string;
  repositoryVersion: string;
  generatedAt: string;
  scan: ScanStats;
  analysis: AnalysisResult;
  symbolMaps: readonly FileSymbolMap[];
  dependencyGraph: DependencyGraph;
}

export interface RepositorySummaryMetrics {
  incrementRepositorySummary(): void;
  observeRepositorySummaryGenerationMs(milliseconds: number): void;
  incrementRepositorySummaryCacheHit(): void;
}

export interface RepositorySummaryLogger {
  info(event: string, fields?: Record<string, unknown>): void;
}
