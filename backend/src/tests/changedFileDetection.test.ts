import { test } from "node:test";
import assert from "node:assert/strict";
import { detectChangedFiles } from "../services/repository/changedFileDetection.js";
import type { ScannedFile } from "../services/repository/scanner.js";
import type { SnapshotFile } from "../services/repository/fileSnapshotStore.js";

function scanned(filePath: string): ScannedFile {
  return { filePath, size: 100, language: ".ts" };
}

function snap(filePath: string): SnapshotFile {
  return { filePath, size: 100, language: ".ts", lastSeenAt: "2020-01-01T00:00:00.000Z" };
}

test("1. no previous snapshot forces full reindex", () => {
  const result = detectChangedFiles(null, [scanned("a.ts"), scanned("b.ts")]);
  assert.equal(result.shouldReindexFully, true);
  assert.deepEqual(result.added, ["a.ts", "b.ts"]);
  assert.deepEqual(result.removed, []);
});

test("2. identical snapshot yields all unchanged", () => {
  const prev = [snap("a.ts"), snap("b.ts")];
  const curr = [scanned("a.ts"), scanned("b.ts")];
  const result = detectChangedFiles(prev, curr);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.unchanged, ["a.ts", "b.ts"]);
  assert.equal(result.totalChangedFiles, 0);
  assert.equal(result.shouldReindexFully, false);
});

test("3. added file detection", () => {
  const prev = [snap("a.ts"), snap("b.ts"), snap("c.ts"), snap("d.ts")];
  const curr = [scanned("a.ts"), scanned("b.ts"), scanned("c.ts"), scanned("d.ts"), scanned("e.ts")];
  const result = detectChangedFiles(prev, curr);
  assert.deepEqual(result.added, ["e.ts"]);
  assert.deepEqual(result.removed, []);
  assert.equal(result.shouldReindexFully, false);
});

test("4. removed file detection", () => {
  const prev = [snap("a.ts"), snap("b.ts"), snap("c.ts"), snap("d.ts"), snap("e.ts")];
  const curr = [scanned("a.ts"), scanned("b.ts"), scanned("c.ts"), scanned("d.ts")];
  const result = detectChangedFiles(prev, curr);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, ["e.ts"]);
  // 1 removed / 5 prev = 0.2, below both thresholds
  assert.equal(result.shouldReindexFully, false);
});

test("5. mixed added/removed/unchanged sorted ascending", () => {
  const prev = [snap("a.ts"), snap("b.ts"), snap("c.ts"), snap("z.ts"), snap("y.ts"), snap("x.ts"), snap("w.ts"), snap("v.ts"), snap("u.ts"), snap("t.ts")];
  const curr = [scanned("c.ts"), scanned("a.ts"), scanned("b.ts"), scanned("m.ts"), scanned("z.ts"), scanned("y.ts"), scanned("x.ts"), scanned("w.ts"), scanned("v.ts"), scanned("u.ts")];
  const result = detectChangedFiles(prev, curr);
  assert.deepEqual(result.added, ["m.ts"]);
  assert.deepEqual(result.removed, ["t.ts"]);
  assert.deepEqual(result.unchanged, ["a.ts", "b.ts", "c.ts", "u.ts", "v.ts", "w.ts", "x.ts", "y.ts", "z.ts"]);
});

test("6. changed ratio fallback triggers full reindex", () => {
  // 2 prev, 2 added + 0 removed => change ratio 1.0 > 0.5
  const prev = [snap("a.ts"), snap("b.ts")];
  const curr = [scanned("a.ts"), scanned("b.ts"), scanned("c.ts"), scanned("d.ts")];
  const result = detectChangedFiles(prev, curr);
  assert.equal(result.shouldReindexFully, true);
});

test("7. removed ratio fallback triggers full reindex", () => {
  // 4 prev, 2 removed => removed ratio 0.5 > 0.3
  const prev = [snap("a.ts"), snap("b.ts"), snap("c.ts"), snap("d.ts")];
  const curr = [scanned("a.ts"), scanned("b.ts")];
  const result = detectChangedFiles(prev, curr);
  assert.deepEqual(result.removed, ["c.ts", "d.ts"]);
  assert.equal(result.shouldReindexFully, true);
});

test("8. empty current scan with non-empty previous forces full reindex", () => {
  const prev = [snap("a.ts"), snap("b.ts")];
  const result = detectChangedFiles(prev, []);
  assert.equal(result.shouldReindexFully, true);
  assert.deepEqual(result.removed, ["a.ts", "b.ts"]);
});

test("9. deterministic repeated execution", () => {
  const prev = [snap("a.ts"), snap("b.ts"), snap("c.ts")];
  const curr = [scanned("b.ts"), scanned("c.ts"), scanned("d.ts")];
  const first = detectChangedFiles(prev, curr);
  const second = detectChangedFiles(prev, curr);
  assert.deepEqual(first, second);
});

test("10. inputs are not mutated", () => {
  const prev = [snap("b.ts"), snap("a.ts")];
  const curr = [scanned("b.ts"), scanned("c.ts")];
  const prevSnapshot = JSON.parse(JSON.stringify(prev));
  const currSnapshot = JSON.parse(JSON.stringify(curr));
  detectChangedFiles(prev, curr);
  assert.deepEqual(prev, prevSnapshot);
  assert.deepEqual(curr, currSnapshot);
});
