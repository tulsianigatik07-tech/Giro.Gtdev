import type { RepositoryOverview } from "./repositoryOverview.js";
import type { RepositoryIndexMetadata } from "./indexingTypes.js";
import { analyzeRepository } from "./repositoryAnalysisService.js";
import { getArchitectureDashboardData } from "./architectureDashboardIntegration.js";
import { buildRetrievalContextSummary } from "./retrievalContextSummary.js";
import {
  buildRetrievalQualityScore,
  type RetrievalQualityInput,
} from "../retrieval/retrievalQualityScore.js";
import { getRepositoryIndexMetadata } from "./indexingService.js";

export interface RepositoryIntelligenceInput {
  repositoryId: string;
  repositoryName: string;
  overview: RepositoryOverview;
  retrievalQuality?: RetrievalQualityInput;
}

export interface RepositoryIntelligenceSummary {
  healthScore: number;
  healthCategory: string;
  hasArchitectureReport: boolean;
  retrievalGrade: string;
  indexStatus: string;
}

export interface RepositoryIntelligenceStatus {
  indexed: boolean;
  architectureReady: boolean;
  retrievalReady: boolean;
  ready: boolean;
}

export interface RepositoryIntelligenceResult {
  repositoryId: string;
  repositoryName: string;
  status: RepositoryIntelligenceStatus;
  summary: RepositoryIntelligenceSummary;
  analysis: ReturnType<typeof analyzeRepository>;
  architecture: ReturnType<typeof getArchitectureDashboardData>;
  indexing: RepositoryIndexMetadata | null;
  retrieval: {
    context: ReturnType<typeof buildRetrievalContextSummary>;
    quality: ReturnType<typeof buildRetrievalQualityScore>;
  };
}

function parseRepositoryId(repositoryId: string): { owner: string; repo: string } | null {
  const [owner, repo] = repositoryId.split("/");

  if (!owner || !repo) {
    return null;
  }

  return { owner, repo };
}

export function buildRepositoryIntelligence(
  input: RepositoryIntelligenceInput,
): RepositoryIntelligenceResult {
  const analysis = analyzeRepository(input.repositoryName, input.overview);
  const architecture = getArchitectureDashboardData(input.repositoryId);

  const parsed = parseRepositoryId(input.repositoryId);
  const indexing = parsed
    ? getRepositoryIndexMetadata(parsed.owner, parsed.repo)
    : null;

  const retrievalContext = buildRetrievalContextSummary(
    input.overview,
    analysis.health.summary,
  );

  const retrievalQuality = buildRetrievalQualityScore(
    input.retrievalQuality ?? {},
  );

  const indexed = indexing?.status === "indexed";

  const status: RepositoryIntelligenceStatus = {
    indexed,
    architectureReady: architecture.hasReport,
    retrievalReady: retrievalQuality.score > 0,
    ready: indexed && architecture.hasReport && retrievalQuality.score > 0,
  };

  return {
    repositoryId: input.repositoryId,
    repositoryName: input.repositoryName,
    status,
    summary: {
      healthScore: analysis.health.summary.healthScore,
      healthCategory: analysis.health.summary.healthCategory,
      hasArchitectureReport: architecture.hasReport,
      retrievalGrade: retrievalQuality.grade,
      indexStatus: indexing?.status ?? "unknown",
    },
    analysis,
    architecture,
    indexing,
    retrieval: {
      context: retrievalContext,
      quality: retrievalQuality,
    },
  };
}