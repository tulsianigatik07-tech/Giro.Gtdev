import { describe, expect, it } from "vitest";

import { buildRepositoryArchitectureInference } from "../services/repository/architectureInferenceBuilder.js";

describe("architecture inference builder", () => {
  it("builds repository architecture inference", () => {
    const inference = buildRepositoryArchitectureInference(
      "demo/repo",
      [
        {
          layerName: "routes",
          filePath: "src/routes/index.ts",
        },
      ] as never,
      [
        {
          componentName: "auth",
          filePath: "src/auth/service.ts",
        },
      ] as never,
      [
        {
          sourceComponent: "auth",
          targetComponent: "database",
          relationKind: "depends_on",
        },
      ] as never,
    );

    expect(inference.repositoryId).toBe("demo/repo");

    expect(inference.layers).toHaveLength(1);
    expect(inference.layers[0]?.name).toBe("routes");

    expect(inference.components).toHaveLength(1);
    expect(inference.components[0]?.name).toBe("auth");

    expect(inference.relations).toHaveLength(1);
    expect(inference.confidence).toBe("medium");
  });
});