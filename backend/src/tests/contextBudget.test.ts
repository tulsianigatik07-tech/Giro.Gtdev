import { test } from "node:test";
import assert from "node:assert/strict";
import { trimContextToBudget } from "../services/context/contextBudget.js";
import { makeChunk, makeChunks } from "./testUtils.js";

test("1. empty input returns empty result", async () => {
  const r = await trimContextToBudget([]);
  assert.deepEqual(r.selected, []);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.estimatedTokens, 0);
});

test("2. score desc ordering", async () => {
  const chunks = [
    makeChunk({ filePath: "a.ts", score: 0.2 }),
    makeChunk({ filePath: "b.ts", score: 0.9 }),
    makeChunk({ filePath: "c.ts", score: 0.5 }),
  ];
  const r = await trimContextToBudget(chunks);
  assert.deepEqual(r.selected.map((c) => c.score), [0.9, 0.5, 0.2]);
});

test("3. filePath asc tiebreak when scores equal", async () => {
  const chunks = [
    makeChunk({ filePath: "z.ts", score: 0.5, startLine: 1 }),
    makeChunk({ filePath: "a.ts", score: 0.5, startLine: 1 }),
  ];
  const r = await trimContextToBudget(chunks);
  assert.deepEqual(r.selected.map((c) => c.filePath), ["a.ts", "z.ts"]);
});

test("4. startLine asc tiebreak when score+path equal", async () => {
  const chunks = [
    makeChunk({ filePath: "a.ts", score: 0.5, startLine: 50, endLine: 60 }),
    makeChunk({ filePath: "a.ts", score: 0.5, startLine: 10, endLine: 20 }),
  ];
  const r = await trimContextToBudget(chunks);
  assert.deepEqual(r.selected.map((c) => c.startLine), [10, 50]);
});

test("5. maxChunks enforcement", async () => {
  const chunks = makeChunks(20);
  const r = await trimContextToBudget(chunks, { maxChunks: 3, maxEstimatedTokens: 100000 });
  assert.equal(r.selected.length, 3);
  assert.equal(r.dropped.length, 17);
});

test("6. token budget enforcement", async () => {
  const chunks = makeChunks(5, [
    { content: "x".repeat(40) }, // 10 tokens
    { content: "x".repeat(40) },
    { content: "x".repeat(40) },
    { content: "x".repeat(40) },
    { content: "x".repeat(40) },
  ]);
  const r = await trimContextToBudget(chunks, { maxChunks: 100, maxEstimatedTokens: 25 });
  assert.ok(r.estimatedTokens <= 25);
  assert.ok(r.selected.length < 5);
});

test("7. oversized first chunk always included", async () => {
  const chunks = [makeChunk({ content: "x".repeat(100000) })];
  const r = await trimContextToBudget(chunks, { maxChunks: 8, maxEstimatedTokens: 10 });
  assert.equal(r.selected.length, 1);
});

test("8. dedupe keeps highest score", async () => {
  const chunks = [
    makeChunk({ filePath: "a.ts", startLine: 1, endLine: 10, score: 0.3 }),
    makeChunk({ filePath: "a.ts", startLine: 1, endLine: 10, score: 0.9 }),
  ];
  const r = await trimContextToBudget(chunks);
  assert.equal(r.selected.length, 1);
  assert.equal(r.selected[0]?.score, 0.9);
});

test("9. input array not mutated", async () => {
  const chunks = makeChunks(5);
  const snapshot = chunks.map((c) => ({ ...c }));
  await trimContextToBudget(chunks);
  assert.deepEqual(chunks, snapshot);
});

test("10. deterministic repeated output", async () => {
  const chunks = makeChunks(12);
  const a = await trimContextToBudget(chunks, { maxChunks: 5, maxEstimatedTokens: 3500 });
  const b = await trimContextToBudget(chunks, { maxChunks: 5, maxEstimatedTokens: 3500 });
  assert.deepEqual(
    a.selected.map((c) => `${c.filePath}:${c.startLine}`),
    b.selected.map((c) => `${c.filePath}:${c.startLine}`),
  );
  assert.equal(a.estimatedTokens, b.estimatedTokens);
});
