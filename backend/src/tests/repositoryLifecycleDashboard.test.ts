import { describe, expect, it } from "vitest";

import { buildRepositoryLifecycleDashboard } from "../services/repository/repositoryLifecycleDashboard.js";

describe("repository lifecycle dashboard", () => {
  it("builds lifecycle dashboard", () => {
    const dashboard = buildRepositoryLifecycleDashboard({
      changes: {
        summary: {
          filesAdded: 3,
          filesModified: 5,
          filesDeleted: 2,
          totalChanges: 10,
        },
        severity: "medium",
        shouldReindex: true,
      },
      decision: {
        shouldReindex: true,
        reason: "Moderate repository changes detected.",
      },
      plan: {
        shouldRun: true,
        mode: "incremental",
        reason: "Moderate repository changes detected.",
      },
    });

    expect(dashboard.totalChanges).toBe(10);
    expect(dashboard.severity).toBe("medium");
    expect(dashboard.reindexMode).toBe("incremental");
    expect(dashboard.shouldRun).toBe(true);
  });
});