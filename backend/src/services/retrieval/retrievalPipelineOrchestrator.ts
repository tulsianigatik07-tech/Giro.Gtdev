import type { RetrievalCandidate } from "./candidateFilter.js";

import { executeRetrieval } from "./retrievalExecutionService.js";

export interface RetrievalPipelineRequest {
  question: string;
  candidates: readonly RetrievalCandidate[];
}

export function executeRetrievalPipeline(
  request: RetrievalPipelineRequest,
) {
  return executeRetrieval({
    question: request.question,
    candidates: request.candidates,
    minScore: 0.5,
    maxCandidates: 8,
    maxCharacters: 16000,
  });
}