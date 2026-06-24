import { describe, expect, it } from "vitest";

import { summarizeGraphUpdatePlan } from "../services/repository/graphUpdateSummary.js";

describe("graph update summary", () => {
  it("summarizes graph update impact", () => {
    const result = summarizeGraphUpdatePlan({
      nodesToAdd: ["src/new.ts"],
      nodesToRefresh: ["src/app.ts"],
      nodesToRemove: ["src/old.ts"],
      affectedFiles: ["src/app.ts", "src/lib.ts", "src/new.ts", "src/old.ts"],
      edgesToRefresh: [
        { from: "src/app.ts", to: "src/lib.ts" },
        { from: "src/lib.ts", to: "src/app.ts" },
      ],
    });

    expect(result).toEqual({
      addedCount: 1,
      refreshedCount: 1,
      removedCount: 1,
      affectedFileCount: 4,
      edgeRefreshCount: 2,
      requiresGraphRebuild: true,
    });
  });

  it("does not require rebuild for empty plan", () => {
    const result = summarizeGraphUpdatePlan({
      nodesToAdd: [],
      nodesToRefresh: [],
      nodesToRemove: [],
      affectedFiles: [],
      edgesToRefresh: [],
    });

    expect(result).toEqual({
      addedCount: 0,
      refreshedCount: 0,
      removedCount: 0,
      affectedFileCount: 0,
      edgeRefreshCount: 0,
      requiresGraphRebuild: false,
    });
  });
});