import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { compareSnapshots } from "../services/repository/repositoryComparisonEngine.js";
import {
  clearSnapshotStore,
  registerSnapshot,
} from "../services/repository/repositorySnapshotStore.js";

interface ComparisonReportFixture {
  health: {
    score: number;
  };
  aiReadiness: {
    score: number;
    blockers: string[];
    recommendations: string[];
  };
  risk: {
    score: number;
    blockers: string[];
  };
  hotspots: {
    hotspots: {
      id: string;
      severity: string;
    }[];
  };
  recommendations: {
    recommendations: {
      id: string;
      title: string;
    }[];
  };
}

function report(input: {
  health?: number;
  aiReadiness?: number;
  risk?: number;
  hotspots?: string[];
  blockers?: string[];
  recommendations?: string[];
} = {}): ComparisonReportFixture {
  const blockers = input.blockers ?? [];
  const recommendations = input.recommendations ?? [];

  return {
    health: {
      score: input.health ?? 80,
    },
    aiReadiness: {
      score: input.aiReadiness ?? 80,
      blockers: [...blockers],
      recommendations: recommendations.map((id) => `${id}-ai`),
    },
    risk: {
      score: input.risk ?? 20,
      blockers: [...blockers],
    },
    hotspots: {
      hotspots: (input.hotspots ?? []).map((id) => ({
        id,
        severity: "high",
      })),
    },
    recommendations: {
      recommendations: recommendations.map((id) => ({
        id,
        title: id,
      })),
    },
  };
}

beforeEach(() => {
  clearSnapshotStore();
});

test("identical snapshots produce stable comparison", () => {
  const snapshot = registerSnapshot("acme/demo", report());

  const comparison = compareSnapshots(snapshot.snapshotId, snapshot.snapshotId);

  assert.equal(comparison.trend, "STABLE");
  assert.equal(comparison.beforeSnapshotId, snapshot.snapshotId);
  assert.equal(comparison.afterSnapshotId, snapshot.snapshotId);
  assert.deepEqual(comparison.health, {
    before: 80,
    after: 80,
    delta: 0,
    trend: "STABLE",
  });
  assert.deepEqual(comparison.hotspotChanges, {
    added: [],
    removed: [],
    unchanged: [],
  });
});

test("improving repository produces improving trend", () => {
  const before = registerSnapshot("acme/demo", report({
    health: 50,
    aiReadiness: 45,
    risk: 80,
    blockers: ["Resolve indexing failures."],
    hotspots: ["architecture.circular-clusters"],
    recommendations: ["readiness.resolve-blockers"],
  }));
  const after = registerSnapshot("acme/demo", report({
    health: 85,
    aiReadiness: 90,
    risk: 20,
  }));

  const comparison = compareSnapshots(before.snapshotId, after.snapshotId);

  assert.equal(comparison.trend, "IMPROVING");
  assert.equal(comparison.health.delta, 35);
  assert.equal(comparison.aiReadiness.delta, 45);
  assert.equal(comparison.risk.delta, -60);
  assert.deepEqual(comparison.blockerChanges.removed, [
    "Resolve indexing failures.",
  ]);
});

test("regressing repository produces regressing trend", () => {
  const before = registerSnapshot("acme/demo", report({
    health: 90,
    aiReadiness: 90,
    risk: 10,
  }));
  const after = registerSnapshot("acme/demo", report({
    health: 40,
    aiReadiness: 35,
    risk: 85,
    blockers: ["Resolve readiness blockers."],
    hotspots: ["architecture.circular-clusters"],
    recommendations: ["readiness.resolve-blockers"],
  }));

  const comparison = compareSnapshots(before.snapshotId, after.snapshotId);

  assert.equal(comparison.trend, "REGRESSING");
  assert.equal(comparison.health.trend, "REGRESSING");
  assert.equal(comparison.aiReadiness.trend, "REGRESSING");
  assert.equal(comparison.risk.trend, "REGRESSING");
});

test("hotspot additions are reported in stable order", () => {
  const before = registerSnapshot("acme/demo", report({
    hotspots: ["z-existing"],
  }));
  const after = registerSnapshot("acme/demo", report({
    hotspots: ["z-existing", "b-new", "a-new"],
  }));

  const comparison = compareSnapshots(before.snapshotId, after.snapshotId);

  assert.deepEqual(comparison.hotspotChanges.added, ["a-new", "b-new"]);
  assert.deepEqual(comparison.hotspotChanges.unchanged, ["z-existing"]);
});

test("blocker removal is reported as improvement", () => {
  const before = registerSnapshot("acme/demo", report({
    blockers: ["z blocker", "a blocker"],
  }));
  const after = registerSnapshot("acme/demo", report({
    blockers: ["z blocker"],
  }));

  const comparison = compareSnapshots(before.snapshotId, after.snapshotId);

  assert.deepEqual(comparison.blockerChanges.removed, ["a blocker"]);
  assert.ok(comparison.summary.improvements.includes("Blockers were removed."));
});

test("recommendation changes include added removed and unchanged", () => {
  const before = registerSnapshot("acme/demo", report({
    recommendations: ["z-keep", "b-remove"],
  }));
  const after = registerSnapshot("acme/demo", report({
    recommendations: ["z-keep", "a-add"],
  }));

  const comparison = compareSnapshots(before.snapshotId, after.snapshotId);

  assert.deepEqual(comparison.recommendationChanges.added, [
    "a-add",
    "a-add-ai",
  ]);
  assert.deepEqual(comparison.recommendationChanges.removed, [
    "b-remove",
    "b-remove-ai",
  ]);
  assert.deepEqual(comparison.recommendationChanges.unchanged, [
    "z-keep",
    "z-keep-ai",
  ]);
});

test("comparison uses stable chronological snapshot ordering", () => {
  const first = registerSnapshot("acme/demo", report({ health: 70 }));
  const second = registerSnapshot("acme/demo", report({ health: 75 }));

  const comparison = compareSnapshots(second.snapshotId, first.snapshotId);

  assert.equal(comparison.beforeSnapshotId, first.snapshotId);
  assert.equal(comparison.afterSnapshotId, second.snapshotId);
  assert.equal(comparison.health.delta, 5);
});

test("comparison output is immutable", () => {
  const before = registerSnapshot("acme/demo", report());
  const after = registerSnapshot("acme/demo", report({ hotspots: ["a-new"] }));

  const comparison = compareSnapshots(before.snapshotId, after.snapshotId);

  assert.equal(Object.isFrozen(comparison), true);
  assert.equal(Object.isFrozen(comparison.health), true);
  assert.equal(Object.isFrozen(comparison.hotspotChanges.added), true);
  assert.throws(() => {
    (comparison.hotspotChanges.added as string[]).push("mutated");
  }, TypeError);
});

test("different repositories throws", () => {
  const first = registerSnapshot("acme/demo", report());
  const second = registerSnapshot("beta/demo", report());

  assert.throws(
    () => compareSnapshots(first.snapshotId, second.snapshotId),
    /different repositories/,
  );
});

test("repeated comparisons produce deterministic isolated output", () => {
  const before = registerSnapshot("acme/demo", report({
    health: 70,
    hotspots: ["b-old"],
    recommendations: ["c-keep"],
  }));
  const after = registerSnapshot("acme/demo", report({
    health: 75,
    hotspots: ["a-new", "b-old"],
    recommendations: ["c-keep", "a-add"],
  }));

  const firstRead = compareSnapshots(before.snapshotId, after.snapshotId);
  const secondRead = compareSnapshots(before.snapshotId, after.snapshotId);

  assert.deepEqual(firstRead, secondRead);
  assert.notEqual(firstRead, secondRead);
  assert.notEqual(firstRead.hotspotChanges, secondRead.hotspotChanges);
  assert.deepEqual(firstRead.hotspotChanges.added, ["a-new"]);
});
