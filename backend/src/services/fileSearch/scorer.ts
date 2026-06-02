// Deterministic per-file relevance scoring from weighted signals.

import { tokenize, meaningfulTokens } from "./tokenizer.js";
import type { FileSymbolMap } from "../graph/types.js";
import type { ScoringSignals } from "./types.js";

const WEIGHTS = {
  filenameMatch: 0.3,
  symbolMatch: 0.3,
  directoryImportance: 0.15,
  keywordOverlap: 0.15,
  centralityBoost: 0.1,
};

const IMPORTANT_DIRS: Array<{ re: RegExp; weight: number }> = [
  { re: /(^|\/)(routes|controllers|handlers)(\/|$)/, weight: 1.0 },
  { re: /(^|\/)(services|lib|core)(\/|$)/, weight: 0.85 },
  { re: /(^|\/)(middleware|db|models)(\/|$)/, weight: 0.8 },
  { re: /(^|\/)(utils|helpers|config)(\/|$)/, weight: 0.6 },
];

function clamp(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function directoryImportance(filePath: string): number {
  const lower = filePath.toLowerCase();
  for (const { re, weight } of IMPORTANT_DIRS) {
    if (re.test(lower)) return weight;
  }
  return 0.3;
}

export function scoreFile(
  queryTokens: string[],
  file: FileSymbolMap,
  centrality: number,
): { signals: ScoringSignals; score: number } {
  const qSet = new Set(queryTokens);
  const pathTokens = tokenize(file.filePath);
  const pathSet = new Set(pathTokens);

  // Filename match: fraction of query tokens present in the path.
  let pathHits = 0;
  for (const t of qSet) if (pathSet.has(t)) pathHits += 1;
  const filenameMatch = qSet.size === 0 ? 0 : clamp(pathHits / qSet.size);

  // Symbol match: best overlap between query tokens and symbol-name tokens.
  let symbolHits = 0;
  for (const sym of file.symbols) {
    const symTokens = new Set(tokenize(sym.name));
    for (const t of qSet) {
      if (symTokens.has(t)) {
        symbolHits += sym.exported ? 1.5 : 1;
        break;
      }
    }
  }
  const symbolMatch =
    file.symbols.length === 0 ? 0 : clamp(symbolHits / file.symbols.length);

  // Keyword overlap: meaningful query tokens appearing anywhere in path/symbols.
  const haystack = new Set<string>([...pathTokens]);
  for (const sym of file.symbols) for (const t of tokenize(sym.name)) haystack.add(t);
  const meaningful = meaningfulTokens([...qSet].join(" "));
  let overlap = 0;
  for (const t of meaningful) if (haystack.has(t)) overlap += 1;
  const keywordOverlap = meaningful.length === 0 ? 0 : clamp(overlap / meaningful.length);

  const signals: ScoringSignals = {
    filenameMatch,
    symbolMatch,
    directoryImportance: directoryImportance(file.filePath),
    keywordOverlap,
    centralityBoost: clamp(centrality),
  };

  const score =
    signals.filenameMatch * WEIGHTS.filenameMatch +
    signals.symbolMatch * WEIGHTS.symbolMatch +
    signals.directoryImportance * WEIGHTS.directoryImportance +
    signals.keywordOverlap * WEIGHTS.keywordOverlap +
    signals.centralityBoost * WEIGHTS.centralityBoost;

  return { signals, score: clamp(score) };
}
