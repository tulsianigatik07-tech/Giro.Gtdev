// In-memory repository symbol index. Maps repoId ("owner/repo") -> the set of
// code symbols known for that repository, keyed/grouped for future incremental
// refresh and deletion. Intentionally temporary: lost on restart, mirroring the
// other in-memory stores (ownershipStore, fileSnapshotStore). A schema-backed
// persistence layer will replace this in a future phase.
//
// Determinism & safety:
// - reads return deep copies (callers cannot mutate stored state)
// - symbols are de-duplicated and sorted deterministically
// - no randomness, no UUIDs, no timestamps
// - inputs are never mutated

import type { ExtractedSymbol, FileSymbolMap, SymbolKind } from "../graph/types.js";

// Compatible with ExtractedSymbol (name/kind/line). startLine/endLine default
// to the single extracted line when an explicit range is not available.
export interface RepositorySymbolRecord {
  filePath: string;
  symbolName: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
}

const store = new Map<string, RepositorySymbolRecord[]>();

function recordKey(s: RepositorySymbolRecord): string {
  return `${s.filePath}\u0000${s.symbolName}\u0000${s.kind}\u0000${s.startLine}\u0000${s.endLine}`;
}

function sortRecords(records: RepositorySymbolRecord[]): RepositorySymbolRecord[] {
  return records.sort(
    (a, b) =>
      a.filePath.localeCompare(b.filePath) ||
      a.startLine - b.startLine ||
      a.symbolName.localeCompare(b.symbolName) ||
      a.kind.localeCompare(b.kind),
  );
}

function normalize(symbols: readonly RepositorySymbolRecord[]): RepositorySymbolRecord[] {
  const seen = new Map<string, RepositorySymbolRecord>();
  for (const s of symbols) {
    const copy: RepositorySymbolRecord = {
      filePath: s.filePath,
      symbolName: s.symbolName,
      kind: s.kind,
      startLine: s.startLine,
      endLine: s.endLine,
    };
    seen.set(recordKey(copy), copy);
  }
  return sortRecords([...seen.values()]);
}

// Helper: build store records from the existing FileSymbolMap[] shape produced
// by the graph symbol extractor. ExtractedSymbol exposes a single `line`, so
// startLine === endLine === line.
export function symbolRecordsFromFileMaps(
  maps: readonly FileSymbolMap[],
): RepositorySymbolRecord[] {
  const records: RepositorySymbolRecord[] = [];
  for (const map of maps) {
    for (const sym of map.symbols as ExtractedSymbol[]) {
      records.push({
        filePath: map.filePath,
        symbolName: sym.name,
        kind: sym.kind,
        startLine: sym.line,
        endLine: sym.line,
      });
    }
  }
  return records;
}

// Overwrites the repository's symbol set with a de-duplicated, sorted copy.
export function saveRepositorySymbols(
  repoId: string,
  symbols: readonly RepositorySymbolRecord[],
): void {
  store.set(repoId, normalize(symbols));
}

export function getRepositorySymbols(repoId: string): RepositorySymbolRecord[] {
  const found = store.get(repoId);
  if (!found) return [];
  return found.map((s) => ({ ...s }));
}

// Number of persisted symbols for a repo (matches what setRepositoryIndexed
// records as symbolCount when persisting an extracted symbol set).
export function getRepositorySymbolCount(repoId: string): number {
  return store.get(repoId)?.length ?? 0;
}

export function getRepositorySymbolsForFile(
  repoId: string,
  filePath: string,
): RepositorySymbolRecord[] {
  const found = store.get(repoId);
  if (!found) return [];
  return found.filter((s) => s.filePath === filePath).map((s) => ({ ...s }));
}

// Removes all symbol records belonging to any of the given file paths.
// Safe for unknown repos and unknown files (no-op).
export function removeRepositorySymbolsForFiles(
  repoId: string,
  filePaths: readonly string[],
): void {
  const found = store.get(repoId);
  if (!found) return;
  const targets = new Set(filePaths);
  store.set(
    repoId,
    found.filter((s) => !targets.has(s.filePath)),
  );
}

// --- Incremental, per-file refresh (for future incremental execution) ---

// Replace ALL records for a single file: drop existing entries for filePath,
// insert the provided symbols (carrying filePath), and re-sort the repo's flat
// array deterministically. Builds the full new array, then assigns atomically
// (via saveRepositorySymbols). Accepts already-extracted ExtractedSymbol[].
export function setFileSymbols(
  repoId: string,
  filePath: string,
  symbols: readonly ExtractedSymbol[],
): void {
  const others = getRepositorySymbols(repoId).filter((s) => s.filePath !== filePath);
  const added: RepositorySymbolRecord[] = symbols.map((sym) => ({
    filePath,
    symbolName: sym.name,
    kind: sym.kind,
    startLine: sym.line,
    endLine: sym.line,
  }));
  saveRepositorySymbols(repoId, [...others, ...added]);
}

// Drop all entries for a single file; other files untouched.
export function removeFileSymbols(repoId: string, filePath: string): void {
  removeRepositorySymbolsForFiles(repoId, [filePath]);
}

// Pure orchestrator: apply per-file removals and changes to a repo's persisted
// symbol set. Accepts ALREADY-EXTRACTED FileSymbolMap[] (no filesystem access).
// Identical input -> deepEqual resulting store state.
export function applyIncrementalSymbolRefresh(
  repoId: string,
  input: { changed: FileSymbolMap[]; removed: string[] },
): void {
  for (const filePath of input.removed) removeFileSymbols(repoId, filePath);
  for (const map of input.changed) setFileSymbols(repoId, map.filePath, map.symbols);
}

// test-only helper — resets the in-memory symbol index
export function clearRepositorySymbols(): void {
  store.clear();
}

// Alias kept for callers that prefer the "...Index" naming.
export function clearRepositorySymbolIndex(): void {
  store.clear();
}
