import { beforeEach, describe, expect, it } from "vitest";

import {
  buildRepositoryActivityTimeline,
  buildRepositoryActivityTimelineForRepository,
} from "../services/repository/repositoryActivityTimeline.js";
import {
  clearRepositoryLifecycleEvents,
  recordRepositoryLifecycleEvent,
  type RepositoryLifecycleEvent,
} from "../services/repository/repositoryLifecycleEvents.js";

beforeEach(() => {
  clearRepositoryLifecycleEvents();
});

function event(
  input: Partial<RepositoryLifecycleEvent> = {},
): RepositoryLifecycleEvent {
  return {
    repositoryId: input.repositoryId ?? "acme/demo",
    sequence: input.sequence ?? 1,
    type: input.type ?? "repository_cleanup_planned",
    message: input.message ?? "Repository cleanup plan built.",
    metadata: input.metadata ?? {},
  };
}

describe("repository activity timeline", () => {
  it("builds an empty timeline", () => {
    expect(buildRepositoryActivityTimeline([])).toEqual([]);
  });

  it("maps lifecycle events to frontend-friendly timeline items", () => {
    const timeline = buildRepositoryActivityTimeline([
      event({
        type: "repository_cleanup_reported",
        message: "Repository cleanup report built.",
        metadata: {
          success: false,
          totalExecuted: 3,
          totalSkipped: 1,
        },
      }),
    ]);

    expect(timeline).toEqual([
      {
        repositoryId: "acme/demo",
        sequence: 1,
        type: "repository_cleanup_reported",
        label: "Cleanup reported",
        title: "Cleanup report created",
        message: "Repository cleanup report built.",
        tone: "success",
        metadata: {
          success: false,
          totalExecuted: 3,
          totalSkipped: 1,
        },
      },
    ]);
  });

  it("preserves stable sequence order", () => {
    const timeline = buildRepositoryActivityTimeline([
      event({
        repositoryId: "beta/api",
        sequence: 3,
        type: "repository_dashboard_viewed",
      }),
      event({
        repositoryId: "acme/demo",
        sequence: 1,
        type: "repository_cleanup_planned",
      }),
      event({
        repositoryId: "acme/demo",
        sequence: 2,
        type: "repository_cleanup_executed",
      }),
    ]);

    expect(timeline.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(timeline.map((item) => item.type)).toEqual([
      "repository_cleanup_planned",
      "repository_cleanup_executed",
      "repository_dashboard_viewed",
    ]);
  });

  it("does not mutate input events", () => {
    const events = [
      event({
        metadata: {
          resources: ["symbols", "metadata"],
        },
      }),
    ];
    const before = structuredClone(events);

    const timeline = buildRepositoryActivityTimeline(events);
    timeline[0]!.metadata.resources = ["mutated"];

    expect(events).toEqual(before);
    expect(buildRepositoryActivityTimeline(events)[0]?.metadata).toEqual({
      resources: ["metadata", "symbols"],
    });
  });

  it("handles metadata values safely and deterministically", () => {
    const timeline = buildRepositoryActivityTimeline([
      event({
        metadata: {
          zeta: "last",
          enabled: true,
          count: 2,
          missing: null,
          resources: ["z.ts", "a.ts"],
        },
      }),
    ]);

    expect(timeline[0]?.metadata).toEqual({
      count: 2,
      enabled: true,
      missing: null,
      resources: ["a.ts", "z.ts"],
      zeta: "last",
    });
  });

  it("produces deterministic output for identical input", () => {
    const events = [
      event({
        sequence: 2,
        type: "repository_cleanup_executed",
        metadata: {
          totalExecuted: 1,
          totalSkipped: 0,
        },
      }),
      event({
        sequence: 1,
        type: "repository_cleanup_planned",
        metadata: {
          cleanupRequired: true,
          totalResources: 1,
        },
      }),
    ];

    expect(buildRepositoryActivityTimeline(events)).toEqual(
      buildRepositoryActivityTimeline(events),
    );
  });

  it("builds a timeline for a repository from recorded events", () => {
    recordRepositoryLifecycleEvent({
      repositoryId: "acme/demo",
      type: "repository_cleanup_planned",
      message: "Repository cleanup plan built.",
    });
    recordRepositoryLifecycleEvent({
      repositoryId: "beta/api",
      type: "repository_dashboard_viewed",
      message: "Repository dashboard summary viewed.",
    });
    recordRepositoryLifecycleEvent({
      repositoryId: "acme/demo",
      type: "repository_cleanup_executed",
      message: "Repository cleanup plan executed.",
    });

    expect(
      buildRepositoryActivityTimelineForRepository("acme/demo").map(
        (item) => item.type,
      ),
    ).toEqual([
      "repository_cleanup_planned",
      "repository_cleanup_executed",
    ]);
  });
});
