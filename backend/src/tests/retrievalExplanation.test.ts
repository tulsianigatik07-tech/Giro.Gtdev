import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRetrievalExplanation,
  type RetrievalExplanationInput,
} from "../services/retrieval/retrievalExplanation.js";

test("1. empty input (only filePath) -> reasons: []", () => {
  const result = buildRetrievalExplanation({ filePath: "src/a.ts" });
  assert.deepEqual(result, { filePath: "src/a.ts", reasons: [] });
});

test("2. symbols only -> single matched symbols reason", () => {
  const result = buildRetrievalExplanation({
    filePath: "src/a.ts",
    matchedSymbols: ["foo", "bar"],
  });
  assert.deepEqual(result.reasons, ["Matched symbols: bar, foo"]);
});

test("3. keywords only -> single matched keywords reason", () => {
  const result = buildRetrievalExplanation({
    filePath: "src/a.ts",
    matchedKeywords: ["session", "auth"],
  });
  assert.deepEqual(result.reasons, ["Matched keywords: auth, session"]);
});

test("4. graph connections only -> single connected files reason", () => {
  const result = buildRetrievalExplanation({
    filePath: "src/a.ts",
    graphConnections: ["src/z.ts", "src/b.ts"],
  });
  assert.deepEqual(result.reasons, ["Connected files: src/b.ts, src/z.ts"]);
});

test("5. combined input -> three reasons in fixed category order", () => {
  const result = buildRetrievalExplanation({
    filePath: "src/a.ts",
    matchedSymbols: ["sym"],
    matchedKeywords: ["kw"],
    graphConnections: ["src/c.ts"],
  });
  assert.deepEqual(result.reasons, [
    "Matched symbols: sym",
    "Matched keywords: kw",
    "Connected files: src/c.ts",
  ]);
});

test("6. deterministic alphabetical ordering within each reason", () => {
  const result = buildRetrievalExplanation({
    filePath: "src/a.ts",
    matchedSymbols: ["charlie", "alpha", "bravo"],
  });
  assert.deepEqual(result.reasons, ["Matched symbols: alpha, bravo, charlie"]);
});

test("7. duplicate values within a category are removed", () => {
  const result = buildRetrievalExplanation({
    filePath: "src/a.ts",
    matchedKeywords: ["x", "x", "y", "x"],
  });
  assert.deepEqual(result.reasons, ["Matched keywords: x, y"]);
});

test("8. inputs are not mutated", () => {
  const input: RetrievalExplanationInput = {
    filePath: "src/a.ts",
    matchedSymbols: ["b", "a"],
    matchedKeywords: ["d", "c"],
    graphConnections: ["f", "e"],
  };
  const snapshot = JSON.parse(JSON.stringify(input));
  buildRetrievalExplanation(input);
  assert.deepEqual(input, snapshot);
});

test("9. repeated calls on identical input are deepEqual", () => {
  const input: RetrievalExplanationInput = {
    filePath: "src/a.ts",
    matchedSymbols: ["b", "a"],
    graphConnections: ["src/y.ts", "src/x.ts"],
  };
  assert.deepEqual(buildRetrievalExplanation(input), buildRetrievalExplanation(input));
});

test("10. large lists remain correctly sorted and de-duplicated", () => {
  const raw = Array.from({ length: 200 }, (_, i) => `sym${(i * 7) % 50}`);
  const result = buildRetrievalExplanation({ filePath: "src/a.ts", matchedSymbols: raw });
  const expected = [...new Set(raw)].sort();
  assert.deepEqual(result.reasons, ["Matched symbols: " + expected.join(", ")]);
});

test("11. explicit undefined / empty arrays yield no reasons", () => {
  const undef = buildRetrievalExplanation({
    filePath: "src/a.ts",
    matchedSymbols: undefined,
    matchedKeywords: undefined,
    graphConnections: undefined,
  });
  assert.deepEqual(undef, { filePath: "src/a.ts", reasons: [] });

  const empty = buildRetrievalExplanation({
    filePath: "src/a.ts",
    matchedSymbols: [],
    matchedKeywords: [],
    graphConnections: [],
  });
  assert.deepEqual(empty, { filePath: "src/a.ts", reasons: [] });
});
