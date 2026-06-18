// Deterministic POST-AGGREGATION layer. Sits ON TOP of the existing assembly
// pipeline (enrichedAssembler.ts / contextAssembler.ts) — it does NOT recompute
// retrieval/embeddings/reranking. It CONSUMES already-retrieved chunks (e.g.
// assembleEnrichedContext(...).context) and enriches them with deterministic
// symbol + graph-neighborhood context from the in-memory stores.
//
// Pure: no I/O, embeddings, FS, timestamps, or randomness; inputs never mutated.
//
// NOTE: symbols are sourced from the graph source store (getFileSymbolMaps),
// whose ExtractedSymbol carries `exported` + `line` — the fields SymbolContextItem
// requires. The symbol index store's records use startLine/endLine and omit
// `exported`, so the graph source maps are the accurate source here.

import type { EnrichedContextChunk } from "./contextTypes.js";
import { getFileSymbolMaps } from "../repository/graphSourceStore.js";
import { buildDependencyGraph } from "../graph/graphBuilder.js";
import { rankFilesByGraphTraversalWeight } from "../retrieval/graphTraversalWeighting.js";

export interface ContextPackageInput {
  owner: string;
  repo: string;
  retrievedChunks: EnrichedContextChunk[];
  maxCodeChunks?: number;
  maxSymbols?: number;
  maxNeighbors?: number;
}

export interface CodeContextItem {
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

export interface SymbolContextItem {
  filePath: string;
  symbolName: string;
  kind: string;
  exported: boolean;
  line: number;
}

export interface GraphNeighborItem {
  filePath: string;
  distance: number | null;
  weight: number;
  reason: string;
}

export interface ContextPackage {
  repository: string;
  code: CodeContextItem[];
  symbols: SymbolContextItem[];
  graphNeighborhood: GraphNeighborItem[];
  stats: {
    codeCount: number;
    symbolCount: number;
    neighborCount: number;
    deduplicatedCount: number;
  };
}

const DEFAULT_MAX_CODE = 10;
const DEFAULT_MAX_SYMBOLS = 25;
const DEFAULT_MAX_NEIGHBORS = 10;

function chunkKey(c: EnrichedContextChunk): string {
  return `${c.filePath}:${c.startLine}:${c.endLine}`;
}

export function buildContextPackage(input: ContextPackageInput): ContextPackage {
  const repoId = `${input.owner}/${input.repo}`;
  const maxCodeChunks = input.maxCodeChunks ?? DEFAULT_MAX_CODE;
  const maxSymbols = input.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const maxNeighbors = input.maxNeighbors ?? DEFAULT_MAX_NEIGHBORS;

  // --- CODE: dedupe by filePath:startLine:endLine (keep highest score) ---
  const byKey = new Map<string, CodeContextItem>();
  let deduplicatedCount = 0;
  for (const c of input.retrievedChunks) {
    const key = chunkKey(c);
    const existing = byKey.get(key);
    if (existing) {
      deduplicatedCount += 1;
      if (c.score > existing.score) {
        byKey.set(key, {
          filePath: c.filePath,
          language: c.language,
          startLine: c.startLine,
          endLine: c.endLine,
          content: c.content,
          score: c.score,
        });
      }
    } else {
      byKey.set(key, {
        filePath: c.filePath,
        language: c.language,
        startLine: c.startLine,
        endLine: c.endLine,
        content: c.content,
        score: c.score,
      });
    }
  }
  const code = [...byKey.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.filePath.localeCompare(b.filePath) ||
        a.startLine - b.startLine,
    )
    .slice(0, maxCodeChunks);

  // --- SYMBOLS: only for the involved (code) files ---
  const involved = new Set(code.map((c) => c.filePath));
  const fileMaps = getFileSymbolMaps(repoId);
  const symbols: SymbolContextItem[] = [];
  for (const map of fileMaps) {
    if (!involved.has(map.filePath)) continue;
    for (const sym of map.symbols) {
      symbols.push({
        filePath: map.filePath,
        symbolName: sym.name,
        kind: sym.kind,
        exported: sym.exported,
        line: sym.line,
      });
    }
  }
  symbols.sort(
    (a, b) =>
      a.filePath.localeCompare(b.filePath) ||
      a.line - b.line ||
      a.symbolName.localeCompare(b.symbolName),
  );
  const cappedSymbols = symbols.slice(0, maxSymbols);

  // --- GRAPH NEIGHBORHOOD: seeded by code files, seeds excluded ---
  const seedFiles = [...involved];
  const allFiles = fileMaps.map((m) => m.filePath);
  const edges = buildDependencyGraph(fileMaps).edges.map((e) => ({ from: e.from, to: e.to }));
  const seedSet = new Set(seedFiles);
  const graphNeighborhood: GraphNeighborItem[] = rankFilesByGraphTraversalWeight(
    allFiles,
    seedFiles,
    edges,
  )
    // Exclude the seed files themselves and keep only structurally-related
    // neighbors (weight > 0); unrelated (weight 0) files are dropped.
    .filter((r) => !seedSet.has(r.filePath) && r.weight > 0)
    .slice(0, maxNeighbors)
    .map((r) => ({
      filePath: r.filePath,
      distance: r.distance,
      weight: r.weight,
      reason: r.reason,
    }));

  return {
    repository: repoId,
    code,
    symbols: cappedSymbols,
    graphNeighborhood,
    stats: {
      codeCount: code.length,
      symbolCount: cappedSymbols.length,
      neighborCount: graphNeighborhood.length,
      deduplicatedCount,
    },
  };
}