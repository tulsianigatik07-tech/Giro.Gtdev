import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  saveRepositorySymbols,
  getRepositorySymbols,
  getRepositorySymbolCount,
  symbolRecordsFromFileMaps,
  clearRepositorySymbolIndex,
} from "../services/repository/symbolIndexStore.js";
import {
  setRepositoryIndexed,
  getRepositoryIndexMetadata,
  clearRepositoryIndexRegistry,
  type IndexedCounts,
} from "../services/repository/indexingService.js";
import { pruneRemovedFileSymbols } from "../services/repository/symbolPruning.js";
import type { FileSymbolMap, SymbolKind } from "../services/graph/types.js";

const COUNTS: IndexedCounts = {
  chunkCount: 0,
  fileCount: 0,
  symbolCount: 0,
  graphNodeCount: 0,
  graphEdgeCount: 0,
  summaryAvailable: false,
};

function fileMap(filePath: string, symbols: Array<[string, SymbolKind, number]>): FileSymbolMap {
  return {
    filePath,
    language: "typescript",
    symbols: symbols.map(([name, kind, line]) => ({ name, kind, exported: true, line })),
    imports: [],
  };
}

// Seed both the symbol store and the registry (symbolCount = flattened count).
function seed(owner: string, repo: string, maps: FileSymbolMap[]): void {
  const repoId = `${owner}/${repo}`;
  const records = symbolRecordsFromFileMaps(maps);
  saveRepositorySymbols(repoId, records);
  const symbolCount = maps.reduce((n, m) => n + m.symbols.length, 0);
  setRepositoryIndexed(owner, repo, { ...COUNTS, symbolCount });
}

beforeEach(() => {
  clearRepositorySymbolIndex();
  clearRepositoryIndexRegistry();
});

test("1. removing a deleted file removes exactly its symbols", () => {
  seed("acme", "demo", [fileMap("src/a.ts", [["foo", "function", 1]]), fileMap("src/b.ts", [["bar", "function", 1]])]);
  pruneRemovedFileSymbols("acme", "demo", ["src/a.ts"]);
  const symbols = getRepositorySymbols("acme/demo");
  assert.ok(!symbols.some((s) => s.filePath === "src/a.ts"));
  assert.equal(symbols.length, 1);
});

test("2. removing one file preserves other files' symbols", () => {
  seed("acme", "demo", [fileMap("src/a.ts", [["foo", "function", 1]]), fileMap("src/b.ts", [["bar", "class", 2]])]);
  const bBefore = JSON.parse(JSON.stringify(getRepositorySymbols("acme/demo").filter((s) => s.filePath === "src/b.ts")));
  pruneRemovedFileSymbols("acme", "demo", ["src/a.ts"]);
  const bAfter = getRepositorySymbols("acme/demo").filter((s) => s.filePath === "src/b.ts");
  assert.deepEqual(bAfter, bBefore);
});

test("3. removing a file that had zero symbols is a safe no-op", () => {
  seed("acme", "demo", [fileMap("src/a.ts", [["foo", "function", 1]])]);
  const before = getRepositorySymbols("acme/demo");
  pruneRemovedFileSymbols("acme", "demo", ["src/ghost.ts"]);
  assert.deepEqual(getRepositorySymbols("acme/demo"), before);
  assert.equal(getRepositoryIndexMetadata("acme", "demo")?.symbolCount, 1);
});

test("4. removing multiple files sequentially prunes each correctly", () => {
  seed("acme", "demo", [
    fileMap("src/a.ts", [["foo", "function", 1]]),
    fileMap("src/b.ts", [["bar", "function", 1]]),
    fileMap("src/c.ts", [["baz", "function", 1]]),
  ]);
  pruneRemovedFileSymbols("acme", "demo", ["src/a.ts", "src/c.ts"]);
  const paths = [...new Set(getRepositorySymbols("acme/demo").map((s) => s.filePath))];
  assert.deepEqual(paths, ["src/b.ts"]);
});

test("5. metadata symbolCount updates to actual remaining count", () => {
  seed("acme", "demo", [
    fileMap("src/a.ts", [["foo", "function", 1], ["foo2", "function", 2]]),
    fileMap("src/b.ts", [["bar", "function", 1]]),
  ]);
  assert.equal(getRepositoryIndexMetadata("acme", "demo")?.symbolCount, 3);
  pruneRemovedFileSymbols("acme", "demo", ["src/a.ts"]);
  assert.equal(getRepositorySymbolCount("acme/demo"), 1);
  assert.equal(getRepositoryIndexMetadata("acme", "demo")?.symbolCount, 1);
});

test("6. deterministic ordering preserved after pruning", () => {
  seed("acme", "demo", [
    fileMap("src/a.ts", [["alpha", "function", 2], ["beta", "function", 9]]),
    fileMap("src/b.ts", [["gamma", "function", 1]]),
    fileMap("src/c.ts", [["delta", "function", 1]]),
  ]);
  pruneRemovedFileSymbols("acme", "demo", ["src/b.ts"]);
  const keys = getRepositorySymbols("acme/demo").map((s) => `${s.filePath}:${s.startLine}:${s.symbolName}`);
  assert.deepEqual(keys, ["src/a.ts:2:alpha", "src/a.ts:9:beta", "src/c.ts:1:delta"]);
});

test("7. repeated pruning of the same file is idempotent", () => {
  seed("acme", "demo", [fileMap("src/a.ts", [["foo", "function", 1]]), fileMap("src/b.ts", [["bar", "function", 1]])]);
  pruneRemovedFileSymbols("acme", "demo", ["src/a.ts"]);
  const afterFirst = getRepositorySymbols("acme/demo");
  const countFirst = getRepositoryIndexMetadata("acme", "demo")?.symbolCount;
  pruneRemovedFileSymbols("acme", "demo", ["src/a.ts"]);
  assert.deepEqual(getRepositorySymbols("acme/demo"), afterFirst);
  assert.equal(getRepositoryIndexMetadata("acme", "demo")?.symbolCount, countFirst);
});

test("8. empty removedFilePaths is a complete no-op", () => {
  seed("acme", "demo", [fileMap("src/a.ts", [["foo", "function", 1]])]);
  const before = getRepositorySymbols("acme/demo");
  const metaBefore = getRepositoryIndexMetadata("acme", "demo");
  pruneRemovedFileSymbols("acme", "demo", []);
  assert.deepEqual(getRepositorySymbols("acme/demo"), before);
  assert.deepEqual(getRepositoryIndexMetadata("acme", "demo"), metaBefore);
});

test("9. ownership isolation: pruning repoA leaves repoB untouched", () => {
  seed("acme", "a", [fileMap("src/a.ts", [["foo", "function", 1]]), fileMap("src/b.ts", [["bar", "function", 1]])]);
  seed("acme", "b", [fileMap("src/x.ts", [["xx", "function", 1]])]);
  const bSymbolsBefore = JSON.parse(JSON.stringify(getRepositorySymbols("acme/b")));
  const bMetaBefore = getRepositoryIndexMetadata("acme", "b");

  pruneRemovedFileSymbols("acme", "a", ["src/a.ts"]);

  assert.deepEqual(getRepositorySymbols("acme/b"), bSymbolsBefore);
  assert.deepEqual(getRepositoryIndexMetadata("acme", "b"), bMetaBefore);
});

test("10. determinism: repeated identical pruning sequences yield deepEqual state", () => {
  const maps = [
    fileMap("src/a.ts", [["foo", "function", 1]]),
    fileMap("src/b.ts", [["bar", "function", 1]]),
    fileMap("src/c.ts", [["baz", "function", 1]]),
  ];
  seed("acme", "one", maps);
  seed("acme", "two", maps);

  pruneRemovedFileSymbols("acme", "one", ["src/b.ts"]);
  pruneRemovedFileSymbols("acme", "two", ["src/b.ts"]);

  assert.deepEqual(getRepositorySymbols("acme/one"), getRepositorySymbols("acme/two"));
  assert.equal(
    getRepositoryIndexMetadata("acme", "one")?.symbolCount,
    getRepositoryIndexMetadata("acme", "two")?.symbolCount,
  );
});
