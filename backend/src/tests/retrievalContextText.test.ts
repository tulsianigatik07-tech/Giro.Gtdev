import test from "node:test";
import assert from "node:assert/strict";
import { buildRetrievalContextText } from "../services/repository/retrievalContextText.js";
import type { RetrievalContextSummary } from "../services/repository/retrievalContextSummary.js";

function summary(overrides?: Partial<RetrievalContextSummary>): RetrievalContextSummary {
  return {
    repositoryScale: "small",
    architectureComplexity: "low",
    healthCategory: "excellent",
    totalFiles: 10,
    totalSymbols: 30,
    totalDependencies: 15,
    retrievalKeywords: [
      "scale:small",
      "complexity:low",
      "health:excellent",
      "files:10",
      "symbols:30",
      "dependencies:15",
    ],
    ...overrides,
  };
}

test("1. exact full-string rendering for a 6-keyword summary", () => {
  assert.equal(
    buildRetrievalContextText(summary()),
    "Repository retrieval context:\n" +
      "- Scale: small\n" +
      "- Architecture complexity: low\n" +
      "- Health category: excellent\n" +
      "- Files: 10\n" +
      "- Symbols: 30\n" +
      "- Dependencies: 15\n" +
      "- Keywords: scale:small, complexity:low, health:excellent, files:10, symbols:30, dependencies:15",
  );
});

test("2. empty keyword array -> '- Keywords: ' (full exact string)", () => {
  assert.equal(
    buildRetrievalContextText(summary({ retrievalKeywords: [] })),
    "Repository retrieval context:\n" +
      "- Scale: small\n" +
      "- Architecture complexity: low\n" +
      "- Health category: excellent\n" +
      "- Files: 10\n" +
      "- Symbols: 30\n" +
      "- Dependencies: 15\n" +
      "- Keywords: ",
  );
});

test("3. single keyword", () => {
  const text = buildRetrievalContextText(summary({ retrievalKeywords: ["scale:large"] }));
  assert.match(text, /^- Keywords: scale:large$/m);
});

test("4. six keywords joined with ', '", () => {
  const text = buildRetrievalContextText(summary());
  const keywordLine = text.split("\n").at(-1);
  assert.equal(
    keywordLine,
    "- Keywords: scale:small, complexity:low, health:excellent, files:10, symbols:30, dependencies:15",
  );
});

test("5. determinism: repeated calls return identical strings", () => {
  const s = summary();
  assert.equal(buildRetrievalContextText(s), buildRetrievalContextText(s));
});

test("6. input immutability (including retrievalKeywords array)", () => {
  const s = summary();
  const snapshot = JSON.parse(JSON.stringify(s));
  buildRetrievalContextText(s);
  assert.deepEqual(s, snapshot);
});

test("7. no trailing newline / no trailing space", () => {
  const text = buildRetrievalContextText(summary());
  assert.ok(!text.endsWith("\n"));
  assert.ok(!text.endsWith(" "));
});

test("8. no leading whitespace; first line exact", () => {
  const text = buildRetrievalContextText(summary());
  assert.equal(text.split("\n")[0], "Repository retrieval context:");
  assert.ok(!text.startsWith(" "));
  assert.ok(!text.startsWith("\n"));
});

test("9. keyword ordering preserved exactly", () => {
  const kws = ["z:1", "a:2", "m:3"];
  const text = buildRetrievalContextText(summary({ retrievalKeywords: kws }));
  assert.match(text, /^- Keywords: z:1, a:2, m:3$/m);
});

test("10. large numeric totals render correctly", () => {
  const text = buildRetrievalContextText(
    summary({ totalFiles: 1_000_000, totalSymbols: 5_000_000, totalDependencies: 9_999_999 }),
  );
  assert.match(text, /^- Files: 1000000$/m);
  assert.match(text, /^- Symbols: 5000000$/m);
  assert.match(text, /^- Dependencies: 9999999$/m);
});

test("11. JSON round-trip of summary produces identical text", () => {
  const s = summary();
  const roundTripped = JSON.parse(JSON.stringify(s)) as RetrievalContextSummary;
  assert.equal(buildRetrievalContextText(s), buildRetrievalContextText(roundTripped));
});

test("12. exactly 8 lines", () => {
  assert.equal(buildRetrievalContextText(summary()).split("\n").length, 8);
});
