import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setRepositoryIndexed,
  getRepositoryIndexMetadata,
  recordIndexingFailure,
  clearRepositoryIndexRegistry,
  type IndexedCounts,
} from "../services/repository/indexingService.js";
import { retryFailedIndexing } from "../services/repository/retryIndexingPlanner.js";
import { executeRetryIndexing } from "../services/repository/retryIndexingExecutor.js";
import {
  saveRepositorySymbols,
  getRepositorySymbols,
  symbolRecordsFromFileMaps,
  clearRepositorySymbolIndex,
} from "../services/repository/symbolIndexStore.js";
import {
  setFileSymbolMap,
  getFileSymbolMaps,
  clearGraphSourceStore,
} from "../services/repository/graphSourceStore.js";
import {
  saveRepositoryFileSnapshot,
  getRepositoryFileSnapshot,
  clearRepositoryFileSnapshots,
} from "../services/repository/fileSnapshotStore.js";
import type { FileSymbolMap, SymbolKind } from "../services/graph/types.js";
import type { ScannedFile } from "../services/repository/scanner.js";

const COUNTS: IndexedCounts = {
  chunkCount: 0,
  fileCount: 0,
  symbolCount: 0,
  graphNodeCount: 0,
  graphEdgeCount: 0,
  summaryAvailable: false,
};

function fileMap(filePath: string, symbols: Array<[string, SymbolKind, number]> = [["x", "function", 1]]): FileSymbolMap {
  return {
    filePath,
    language: "typescript",
    symbols: symbols.map(([name, kind, line]) => ({ name, kind, exported: true, line })),
    imports: [],
  };
}

function scanned(filePath: string): ScannedFile {
  return { filePath, size: 1, language: ".ts" };
}

// Seed a repo whose completed files are already persisted, then mark it failed.
function seedFailed(owner: string, repo: string, completed: FileSymbolMap[]): void {
  const repoId = `${owner}/${repo}`;
  setRepositoryIndexed(owner, repo, COUNTS);
  saveRepositorySymbols(repoId, symbolRecordsFromFileMaps(completed));
  for (const m of completed) setFileSymbolMap(repoId, m);
  recordIndexingFailure(owner, repo, {
    reason: "boom",
    failedFileCount: 1,
    lastSuccessfulFile: completed.at(-1)?.filePath ?? null,
  });
}

beforeEach(() => {
  clearRepositoryIndexRegistry();
  clearRepositorySymbolIndex();
  clearGraphSourceStore();
  clearRepositoryFileSnapshots();
});

test("1. recordIndexingFailure sets status:failed + failure fields", () => {
  setRepositoryIndexed("o", "r", COUNTS);
  recordIndexingFailure("o", "r", { reason: "disk full", failedFileCount: 3, lastSuccessfulFile: "src/a.ts" });
  const meta = getRepositoryIndexMetadata("o", "r");
  assert.equal(meta?.status, "failed");
  assert.equal(meta?.failureReason, "disk full");
  assert.equal(meta?.failedFileCount, 3);
  assert.equal(meta?.lastSuccessfulFile, "src/a.ts");
  assert.notEqual(meta?.lastFailureAt, null);
});

test("2. retry plan: eligible only when failed; correct remaining/preserved", () => {
  seedFailed("o", "r", [fileMap("src/a.ts")]);
  const plan = retryFailedIndexing("o", "r", { allFiles: ["src/a.ts", "src/b.ts"], completedFiles: ["src/a.ts"] });
  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.remainingFiles, ["src/b.ts"]);
  assert.deepEqual(plan.preservedFiles, ["src/a.ts"]);
});

test("3. retry plan on non-failed repo -> eligible:false, empty", () => {
  setRepositoryIndexed("o", "r", COUNTS); // indexed
  const indexed = retryFailedIndexing("o", "r", { allFiles: ["src/a.ts"], completedFiles: [] });
  assert.deepEqual(indexed, { eligible: false, remainingFiles: [], preservedFiles: [] });
  // absent repo
  const absent = retryFailedIndexing("o", "ghost", { allFiles: ["src/a.ts"], completedFiles: [] });
  assert.equal(absent.eligible, false);
});

test("4. empty retry plan: allFiles === completedFiles -> remaining []", () => {
  seedFailed("o", "r", [fileMap("src/a.ts")]);
  const plan = retryFailedIndexing("o", "r", { allFiles: ["src/a.ts"], completedFiles: ["src/a.ts"] });
  assert.deepEqual(plan.remainingFiles, []);
  assert.deepEqual(plan.preservedFiles, ["src/a.ts"]);
});

test("5. retry execution processes only remaining files (no duplicates)", () => {
  seedFailed("o", "r", [fileMap("src/a.ts")]);
  executeRetryIndexing("o", "r", { remaining: [fileMap("src/b.ts")] });
  const paths = [...new Set(getRepositorySymbols("o/r").map((s) => s.filePath))].sort();
  assert.deepEqual(paths, ["src/a.ts", "src/b.ts"]);
  // no duplicate symbol records
  assert.equal(getRepositorySymbols("o/r").length, 2);
});

test("6. retry preserves already-indexed files' symbols", () => {
  seedFailed("o", "r", [fileMap("src/a.ts", [["keep", "function", 1]])]);
  const aBefore = JSON.parse(JSON.stringify(getRepositorySymbols("o/r").filter((s) => s.filePath === "src/a.ts")));
  executeRetryIndexing("o", "r", { remaining: [fileMap("src/b.ts")] });
  const aAfter = getRepositorySymbols("o/r").filter((s) => s.filePath === "src/a.ts");
  assert.deepEqual(aAfter, aBefore);
});

test("7. retry preserves graph source state for completed files", () => {
  seedFailed("o", "r", [fileMap("src/a.ts")]);
  const aBefore = getFileSymbolMaps("o/r").find((m) => m.filePath === "src/a.ts");
  executeRetryIndexing("o", "r", { remaining: [fileMap("src/b.ts")] });
  const aAfter = getFileSymbolMaps("o/r").find((m) => m.filePath === "src/a.ts");
  assert.deepEqual(aAfter, aBefore);
});

test("8. retry preserves snapshots for completed files", () => {
  seedFailed("o", "r", [fileMap("src/a.ts")]);
  saveRepositoryFileSnapshot("o/r", [scanned("src/a.ts")]);
  const snapBefore = getRepositoryFileSnapshot("o/r");
  executeRetryIndexing("o", "r", { remaining: [fileMap("src/b.ts")] });
  assert.deepEqual(getRepositoryFileSnapshot("o/r"), snapBefore);
});

test("9. retry updates metadata: retryCount++, timestamps set, status indexed", () => {
  seedFailed("o", "r", [fileMap("src/a.ts")]);
  const before = getRepositoryIndexMetadata("o", "r");
  assert.equal(before?.retryCount, 0);
  executeRetryIndexing("o", "r", { remaining: [fileMap("src/b.ts")] });
  const after = getRepositoryIndexMetadata("o", "r");
  assert.equal(after?.retryCount, 1);
  assert.notEqual(after?.lastRetryAt, null);
  assert.equal(after?.status, "indexed");
  // failure fields cleared on success
  assert.equal(after?.failureReason, null);
  assert.equal(after?.failedFileCount, 0);
});

test("10. repeated retry is idempotent (symbols/graph/snapshot/status/retryCount)", () => {
  seedFailed("o", "r", [fileMap("src/a.ts")]);
  saveRepositoryFileSnapshot("o/r", [scanned("src/a.ts")]);
  const work = { remaining: [fileMap("src/b.ts")] };

  executeRetryIndexing("o", "r", work);
  const symbols1 = getRepositorySymbols("o/r");
  const maps1 = getFileSymbolMaps("o/r");
  const snap1 = getRepositoryFileSnapshot("o/r");
  const status1 = getRepositoryIndexMetadata("o", "r")?.status;
  const retry1 = getRepositoryIndexMetadata("o", "r")?.retryCount;

  // subsequent calls are no-ops (repo no longer "failed")
  executeRetryIndexing("o", "r", work);
  executeRetryIndexing("o", "r", work);

  assert.deepEqual(getRepositorySymbols("o/r"), symbols1);
  assert.deepEqual(getFileSymbolMaps("o/r"), maps1);
  assert.deepEqual(getRepositoryFileSnapshot("o/r"), snap1);
  assert.equal(getRepositoryIndexMetadata("o", "r")?.status, status1);
  assert.equal(getRepositoryIndexMetadata("o", "r")?.retryCount, retry1); // stays 1
});

test("11. ownership isolation: retrying repoA never affects repoB", () => {
  seedFailed("o", "a", [fileMap("src/a.ts")]);
  seedFailed("o", "b", [fileMap("src/x.ts")]);
  const bSymbolsBefore = JSON.parse(JSON.stringify(getRepositorySymbols("o/b")));
  const bMapsBefore = JSON.parse(JSON.stringify(getFileSymbolMaps("o/b")));
  const bMetaBefore = getRepositoryIndexMetadata("o", "b");

  executeRetryIndexing("o", "a", { remaining: [fileMap("src/a2.ts")] });

  assert.deepEqual(getRepositorySymbols("o/b"), bSymbolsBefore);
  assert.deepEqual(getFileSymbolMaps("o/b"), bMapsBefore);
  assert.deepEqual(getRepositoryIndexMetadata("o", "b"), bMetaBefore);
});
