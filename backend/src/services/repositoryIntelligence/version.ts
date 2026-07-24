import { createHash } from "node:crypto";
import { REPOSITORY_INTELLIGENCE_ANALYSIS_VERSION } from "./types.js";

export interface IntelligenceVersionIdentity {
  repositoryRevision: string;
  graphVersion: string;
  embeddingVersion: string;
  parserVersion: string;
  analysisVersion?: string;
}

export function deterministicIntelligenceVersion(input: IntelligenceVersionIdentity): string {
  const digest = createHash("sha256").update(JSON.stringify([
    input.repositoryRevision,
    input.graphVersion,
    input.embeddingVersion,
    input.parserVersion,
    input.analysisVersion ?? REPOSITORY_INTELLIGENCE_ANALYSIS_VERSION,
  ])).digest("hex");
  return `ri-${digest}`;
}
