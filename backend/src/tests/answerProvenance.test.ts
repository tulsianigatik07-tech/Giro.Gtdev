import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnswerProvenance } from "../services/retrieval/answerProvenance.js";
import type { EnrichedContextChunk } from "../services/context/contextTypes.js";

function chunk(overrides?: Partial<EnrichedContextChunk>): EnrichedContextChunk {
  return {
    filePath: "src/a.ts",
    language: "typescript",
    content: "const a = 1;",
    startLine: 1,
    endLine: 10,
    score: 0.5,
    source: "semantic",
    signals: { semantic: 0.5 },
    ...overrides,
  };
}

test("1. empty input returns zeroed provenance", () => {
  assert.deepEqual(buildAnswerProvenance([]), {
    files: [],
    totalFiles: 0,
    totalChunks: 0,
  });
});

test("2. single file with multiple chunks => one entry, correct count", () => {
  const p = buildAnswerProvenance([
    chunk({ filePath: "a.ts", startLine: 1 }),
    chunk({ filePath: "a.ts", startLine: 20 }),
    chunk({ filePath: "a.ts", startLine: 40 }),
  ]);
  assert.equal(p.files.length, 1);
  assert.deepEqual(p.files[0], { filePath: "a.ts", chunkCount: 3 });
});

test("3. multiple files produce multiple entries", () => {
  const p = buildAnswerProvenance([
    chunk({ filePath: "a.ts" }),
    chunk({ filePath: "b.ts" }),
    chunk({ filePath: "c.ts" }),
  ]);
  assert.equal(p.files.length, 3);
});

test("4. sorted by chunkCount descending", () => {
  const p = buildAnswerProvenance([
    chunk({ filePath: "low.ts", startLine: 1 }),
    chunk({ filePath: "high.ts", startLine: 1 }),
    chunk({ filePath: "high.ts", startLine: 20 }),
    chunk({ filePath: "high.ts", startLine: 40 }),
    chunk({ filePath: "mid.ts", startLine: 1 }),
    chunk({ filePath: "mid.ts", startLine: 20 }),
  ]);
  assert.deepEqual(
    p.files.map((f) => f.filePath),
    ["high.ts", "mid.ts", "low.ts"],
  );
});

test("5. alphabetical filePath tiebreak when counts equal", () => {
  const p = buildAnswerProvenance([
    chunk({ filePath: "zebra.ts" }),
    chunk({ filePath: "apple.ts" }),
    chunk({ filePath: "mango.ts" }),
  ]);
  assert.deepEqual(
    p.files.map((f) => f.filePath),
    ["apple.ts", "mango.ts", "zebra.ts"],
  );
});

test("6. deterministic repeated execution", () => {
  const input = [
    chunk({ filePath: "a.ts", startLine: 1 }),
    chunk({ filePath: "a.ts", startLine: 20 }),
    chunk({ filePath: "b.ts" }),
  ];
  assert.deepEqual(buildAnswerProvenance(input), buildAnswerProvenance(input));
});

test("7. input chunk array is not mutated", () => {
  const input = [chunk({ filePath: "a.ts" }), chunk({ filePath: "b.ts" })];
  const snapshot = input.map((c) => ({ ...c, signals: { ...c.signals } }));
  buildAnswerProvenance(input);
  assert.deepEqual(input, snapshot);
});

test("8. totalFiles equals number of distinct files", () => {
  const p = buildAnswerProvenance([
    chunk({ filePath: "a.ts", startLine: 1 }),
    chunk({ filePath: "a.ts", startLine: 20 }),
    chunk({ filePath: "b.ts" }),
  ]);
  assert.equal(p.totalFiles, 2);
});

test("9. totalChunks equals input length", () => {
  const p = buildAnswerProvenance([
    chunk({ filePath: "a.ts" }),
    chunk({ filePath: "a.ts" }),
    chunk({ filePath: "b.ts" }),
    chunk({ filePath: "c.ts" }),
  ]);
  assert.equal(p.totalChunks, 4);
});
