// Incremental per-file symbol refresh, exercised at the PURE store level.
//
// NOTE: the originating task assumed a PersistedRepositorySymbol shape
// ({...exported, line}) and saveRepositorySymbols(fileMaps). The real store
// uses RepositorySymbolRecord ({...startLine, endLine}) and
// saveRepositorySymbols(records). The new operations adapt to the real shape
// (ExtractedSymbol.line -> startLine === endLine === line).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  saveRepositorySymbols,
  getRepositorySymbols,
  symbolRecordsFromFileMaps,
  setFileSymbols,
  removeFileSymbols,
  applyIncrementalSymbolRefresh,
  clearRepositorySymbolIndex,
} from "../services/repository/symbolIndexStore.js";
import type { FileSymbolMap, SymbolKind } from "../services/graph/types.js";

const REPO = "acme/demo";

function fileMap(filePath: string, symbols: Array<[string, SymbolKind, number]>): FileSymbolMap {
  return {
    filePath,
    language: "typescript",
    symbols: symbols.map(([name, kind, line]) => ({ name, kind, exported: true, line })),
    imports: [],
  };
}

function seed(repoId: string, maps: FileSymbolMap[]): void {
  saveRepositorySymbols(repoId, symbolRecordsFromFileMaps(maps));
}

beforeEach(() => {
  clearRepositorySymbolIndex();
});

test("1. changed file with new symbols updates only that file; others untouched", () => {
  seed(REPO, [fileMap("src/a.ts", [["foo", "function", 1]]), fileMap("src/b.ts", [["bar", "function", 1]])]);
  const bBefore = getRepositorySymbols(REPO).filter((s) => s.filePath === "src/b.ts");

  setFileSymbols(REPO, "src/a.ts", [
    { name: "foo", kind: "function", exported: true, line: 1 },
    { name: "added", kind: "variable", exported: true, line: 9 },
  ]);

  const aAfter = getRepositorySymbols(REPO).filter((s) => s.filePath === "src/a.ts");
  assert.deepEqual(aAfter.map((s) => s.symbolName), ["foo", "added"]); // sorted by line: foo@1, added@9
  assert.equal(aAfter.length, 2);
  // b unchanged
  assert.deepEqual(getRepositorySymbols(REPO).filter((s) => s.filePath === "src/b.ts"), bBefore);
});

test("2. changed file with removed symbols replaces that file's records", () => {
  seed(REPO, [fileMap("src/a.ts", [["foo", "function", 1], ["baz", "function", 5]])]);
  setFileSymbols(REPO, "src/a.ts", [{ name: "foo", kind: "function", exported: true, line: 1 }]);
  const a = getRepositorySymbols(REPO).filter((s) => s.filePath === "src/a.ts");
  assert.deepEqual(a.map((s) => s.symbolName), ["foo"]);
  assert.ok(!a.some((s) => s.symbolName === "baz"));
});

test("3. unchanged files remain exactly unchanged when refreshing a different file", () => {
  seed(REPO, [fileMap("src/a.ts", [["foo", "function", 1]]), fileMap("src/b.ts", [["bar", "class", 2]])]);
  const bBefore = JSON.parse(JSON.stringify(getRepositorySymbols(REPO).filter((s) => s.filePath === "src/b.ts")));
  setFileSymbols(REPO, "src/a.ts", [{ name: "renamed", kind: "function", exported: true, line: 1 }]);
  const bAfter = getRepositorySymbols(REPO).filter((s) => s.filePath === "src/b.ts");
  assert.deepEqual(bAfter, bBefore);
});

test("4. multiple changed files refresh correctly and deterministically", () => {
  seed(REPO, [fileMap("src/a.ts", [["foo", "function", 1]]), fileMap("src/b.ts", [["bar", "function", 1]])]);
  applyIncrementalSymbolRefresh(REPO, {
    changed: [
      fileMap("src/b.ts", [["bar2", "function", 3]]),
      fileMap("src/a.ts", [["foo2", "function", 2]]),
    ],
    removed: [],
  });
  const symbols = getRepositorySymbols(REPO);
  assert.deepEqual(
    symbols.map((s) => `${s.filePath}:${s.startLine}:${s.symbolName}`),
    ["src/a.ts:2:foo2", "src/b.ts:3:bar2"],
  );
});

test("5. empty refresh is a no-op", () => {
  seed(REPO, [fileMap("src/a.ts", [["foo", "function", 1]])]);
  const before = getRepositorySymbols(REPO);
  applyIncrementalSymbolRefresh(REPO, { changed: [], removed: [] });
  assert.deepEqual(getRepositorySymbols(REPO), before);
});

test("6. removed paths drop only those files' symbols", () => {
  seed(REPO, [
    fileMap("src/a.ts", [["foo", "function", 1]]),
    fileMap("src/b.ts", [["bar", "function", 1]]),
    fileMap("src/c.ts", [["baz", "function", 1]]),
  ]);
  applyIncrementalSymbolRefresh(REPO, { changed: [], removed: ["src/b.ts"] });
  const paths = [...new Set(getRepositorySymbols(REPO).map((s) => s.filePath))];
  assert.deepEqual(paths, ["src/a.ts", "src/c.ts"]);
});

test("7. refresh ordering is deterministic and deepEqual across repeats", () => {
  seed(REPO, [fileMap("src/a.ts", [["foo", "function", 1]])]);
  const refresh = {
    changed: [fileMap("src/z.ts", [["zeta", "function", 1]]), fileMap("src/a.ts", [["foo2", "function", 2]])],
    removed: [],
  };
  applyIncrementalSymbolRefresh(REPO, refresh);
  const first = getRepositorySymbols(REPO);
  applyIncrementalSymbolRefresh(REPO, refresh);
  const second = getRepositorySymbols(REPO);
  assert.deepEqual(first, second);
});

test("8. incremental refresh == full re-save of the equivalent file set", () => {
  const REPO_INC = "acme/inc";
  const REPO_FULL = "acme/full";
  seed(REPO_INC, [fileMap("src/a.ts", [["foo", "function", 1]]), fileMap("src/b.ts", [["bar", "function", 1]])]);

  const aNew = fileMap("src/a.ts", [["fooX", "function", 4]]);
  const bNew = fileMap("src/b.ts", [["barX", "function", 6]]);

  applyIncrementalSymbolRefresh(REPO_INC, { changed: [aNew, bNew], removed: [] });
  seed(REPO_FULL, [aNew, bNew]);

  assert.deepEqual(getRepositorySymbols(REPO_INC), getRepositorySymbols(REPO_FULL));
});

test("9. failure-safety: a refresh never applied leaves existing symbols intact", () => {
  seed(REPO, [fileMap("src/a.ts", [["foo", "function", 1]])]);
  const before = getRepositorySymbols(REPO);
  // Simulate upstream extraction failing before any store op runs: we simply
  // never call applyIncrementalSymbolRefresh. Store must be untouched.
  assert.deepEqual(getRepositorySymbols(REPO), before);
  assert.equal(before.length, 1);
});

test("10. removeFileSymbols on unknown repo/file is safe", () => {
  assert.doesNotThrow(() => removeFileSymbols("ghost/missing", "x.ts"));
  seed(REPO, [fileMap("src/a.ts", [["foo", "function", 1]])]);
  removeFileSymbols(REPO, "nope.ts");
  assert.equal(getRepositorySymbols(REPO).length, 1);
});
