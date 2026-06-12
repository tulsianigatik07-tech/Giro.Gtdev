import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildIndexCleanupPlan,
  buildIndexCleanupPlanFromIndexingPlan,
  executeIndexCleanup,
} from "../services/repository/indexCleanup.js";
import type { RepositoryIndexingPlan } from "../services/repository/indexingPlan.js";

describe("indexCleanup", () => {
  it("no removed files => cleanupRequired false", () => {
    const plan = buildIndexCleanupPlan([]);
    assert.equal(plan.cleanupRequired, false);
    assert.deepEqual(plan.removedFiles, []);
    assert.match(plan.reason, /no removed files/);
    const result = executeIndexCleanup(plan);
    assert.equal(result.cleanupRequired, false);
    assert.equal(result.cleanedFileCount, 0);
    assert.equal(result.skippedFileCount, 0);
  });

  it("removed files => cleanupRequired true", () => {
    const plan = buildIndexCleanupPlan(["src/a.ts", "src/b.ts"]);
    assert.equal(plan.cleanupRequired, true);
    const result = executeIndexCleanup(plan);
    assert.equal(result.cleanupRequired, true);
    assert.equal(result.cleanedFileCount, 2);
    assert.deepEqual(result.removedFiles, ["src/a.ts", "src/b.ts"]);
  });

  it("removed files are sorted deterministically", () => {
    const plan = buildIndexCleanupPlan(["src/z.ts", "src/a.ts", "src/m.ts"]);
    assert.deepEqual(plan.removedFiles, ["src/a.ts", "src/m.ts", "src/z.ts"]);
  });

  it("duplicate removed files are handled safely (de-duplicated)", () => {
    const plan = buildIndexCleanupPlan(["src/a.ts", "src/a.ts", "src/b.ts", "src/a.ts"]);
    assert.deepEqual(plan.removedFiles, ["src/a.ts", "src/b.ts"]);
    const result = executeIndexCleanup(plan);
    assert.equal(result.cleanedFileCount, 2);
  });

  it("empty input does not crash", () => {
    assert.doesNotThrow(() => executeIndexCleanup(buildIndexCleanupPlan([])));
  });

  it("cleanup result is deterministic across repeated runs", () => {
    const input = ["src/c.ts", "src/a.ts", "src/b.ts", "src/a.ts"];
    const first = executeIndexCleanup(buildIndexCleanupPlan(input));
    const second = executeIndexCleanup(buildIndexCleanupPlan(input));
    assert.deepEqual(first, second);
  });

  it("inputs are not mutated", () => {
    const input = ["src/z.ts", "src/a.ts", "src/z.ts"];
    const copy = [...input];
    buildIndexCleanupPlan(input);
    assert.deepEqual(input, copy);
  });

  it("derives cleanup plan from an indexing plan", () => {
    const indexingPlan: RepositoryIndexingPlan = {
      mode: "incremental",
      addedFiles: ["src/new.ts"],
      removedFiles: ["src/gone2.ts", "src/gone1.ts"],
      unchangedFiles: ["src/keep.ts"],
      totalChangedFiles: 3,
      reason: "incremental: 3 file(s) changed",
    };
    const indexingPlanCopy = JSON.parse(JSON.stringify(indexingPlan));
    const cleanup = buildIndexCleanupPlanFromIndexingPlan(indexingPlan);
    assert.equal(cleanup.cleanupRequired, true);
    assert.deepEqual(cleanup.removedFiles, ["src/gone1.ts", "src/gone2.ts"]);
    // indexing plan must not be mutated
    assert.deepEqual(indexingPlan, indexingPlanCopy);
  });
});
