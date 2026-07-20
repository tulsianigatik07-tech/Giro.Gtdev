
import { buildArchitectureInput } from "./architecturePipeline.js";
import { analyzeArchitectureLayers } from "./architectureLayerAnalysis.js";
import { analyzeArchitectureComponents } from "./architectureComponentAnalysis.js";
import { analyzeArchitectureRelations } from "./architectureRelationAnalysis.js";
import { buildRepositoryArchitectureInference } from "./architectureInferenceBuilder.js";

import { DEFAULT_ARCHITECTURE_LAYER_RULES } from "./architectureLayerDetectorDefaults.js";
import { DEFAULT_ARCHITECTURE_COMPONENT_RULES } from "./architectureComponentDefaults.js";
import type { TrustedRepositoryCheckoutPath } from "../security/repositoryPaths.js";

export function runArchitectureEngine(
  repositoryId: string,
  repositoryPath: TrustedRepositoryCheckoutPath,
) {
  const input = buildArchitectureInput(repositoryPath);

  const layers = analyzeArchitectureLayers(
    repositoryId,
    input.files,
    DEFAULT_ARCHITECTURE_LAYER_RULES,
  );

  const components = analyzeArchitectureComponents(
    repositoryId,
    input.files,
    DEFAULT_ARCHITECTURE_COMPONENT_RULES,
  );

  const relations = analyzeArchitectureRelations(
    repositoryId,
    components.matches.map((match) => match.componentName),
    "depends_on",
  );

  return buildRepositoryArchitectureInference(
    repositoryId,
    layers.matches,
    components.matches,
    relations.matches,
  );
}
