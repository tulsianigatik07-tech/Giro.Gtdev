// Pure aggregation of the two deterministic repository summaries into one
// stable object for future UI consumption. NOT AI, NOT retrieval, NOT
// summarization — delegation only, no transformation, no added logic.
// Pure: no I/O, no module state; never mutates metadata or graph.

import type { RepositoryIndexMetadata } from "./indexingTypes.js";
import type { DependencyGraph } from "../graph/types.js";
import {
  buildRepositoryStructureSummary,
  type RepositoryStructureSummary,
} from "./repositoryStructureSummary.js";
import {
  buildRepositoryArchitectureSummary,
  type RepositoryArchitectureSummary,
} from "./repositoryArchitectureSummary.js";

export interface RepositoryOverview {
  structure: RepositoryStructureSummary;
  architecture: RepositoryArchitectureSummary;
}

export function buildRepositoryOverview(
  metadata: RepositoryIndexMetadata,
  graph: DependencyGraph,
): RepositoryOverview {
  return {
    structure: buildRepositoryStructureSummary(metadata),
    architecture: buildRepositoryArchitectureSummary(graph),
  };
}
