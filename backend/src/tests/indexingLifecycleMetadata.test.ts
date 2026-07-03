import { describe, expect, it, beforeEach } from "vitest";

import {
  clearRepositoryIndexRegistry,
  getRepositoryIndexMetadata,
  recordRepositoryLifecycleReport,
} from "../services/repository/indexingService.js";

describe("indexing lifecycle metadata", () => {
  beforeEach(() => {
    clearRepositoryIndexRegistry();
  });

  it("records repository lifecycle metadata", () => {
    recordRepositoryLifecycleReport("acme", "demo", {
      changes: {
        summary: {
          filesAdded: 3,
          filesModified: 6,
          filesDeleted: 1,
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

    const metadata = getRepositoryIndexMetadata("acme", "demo");

    expect(metadata?.lastLifecycleSeverity).toBe("medium");
    expect(metadata?.lastReindexMode).toBe("incremental");
    expect(metadata?.lastReindexReason).toBe(
      "Moderate repository changes detected.",
    );
  });
});