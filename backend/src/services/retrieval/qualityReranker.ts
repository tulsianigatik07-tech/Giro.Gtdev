// Deterministic retrieval-quality reranker operating on EnrichedContextChunk.
// No randomness, no timestamps, no network. Input arrays are never mutated.

import type { EnrichedContextChunk } from "../context/contextTypes.js";

// --- Tunable weights (documented) ---
const NEUTRAL_SCORE = 0.5; // assigned when all scores are equal/zero
const BOOST_CONTENT_PER_TOKEN = 0.15; // additive per distinct token in content
const BOOST_CONTENT_CAP = 0.3; // max total content boost
const BOOST_FILEPATH = 0.2; // token found in filePath
const BOOST_SYMBOL = 0.15; // token matched on a word boundary in content
const DIVERSITY_PENALTY = 0.05; // per repeat from same file: -0.05 * (N-1)

// --- Cross-file relevance boosting (documented) ---
const SEED_SCORE_THRESHOLD = 0.75; // a chunk's score to qualify its file as a seed
const MAX_SEEDS = 5; // cap on seed files considered
const CROSS_FILE_BOOST_PER_SEED = 0.08; // additive per distinct relating seed
const CROSS_FILE_BOOST_CAP = 0.16; // max total cross-file boost per chunk

const SUFFIX_FAMILIES = [
  ".types.ts", ".service.ts", ".store.ts", ".route.ts",
  ".controller.ts", ".test.ts",
];

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "how", "does", "what", "this", "that",
  "from", "into", "are", "was", "but", "not", "you", "your", "use", "used",
  "where", "when", "which", "who", "why", "can", "will", "all", "any",
]);

export interface RerankStatistics {
  originalChunkCount: number;
  rerankedChunkCount: number;
  duplicateChunksRemoved: number;
  boostedChunkCount: number;
  crossFileBoostedChunkCount: number;
}

export interface RerankOptions {
  relatedFiles?: Record<string, string[]>;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function dirOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "" : filePath.slice(0, idx);
}

function baseName(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? filePath : filePath.slice(idx + 1);
}

// Strips known suffix families and extension to a "family stem" so that
// session.ts / sessionService.ts / session.types.ts group together.
function familyStem(filePath: string): string {
  let name = baseName(filePath).toLowerCase();
  for (const suffix of SUFFIX_FAMILIES) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  name = name.replace(/\.[a-z0-9]+$/, "");
  name = name.replace(/(service|store|types|route|controller|test|handler)$/i, "");
  return name;
}

function suffixFamily(filePath: string): string | null {
  const name = baseName(filePath).toLowerCase();
  for (const suffix of SUFFIX_FAMILIES) {
    if (name.endsWith(suffix)) return suffix;
  }
  return null;
}

// Deterministic filename-heuristic relatedness: same directory, OR same
// basename family stem, OR shared suffix family.
function heuristicallyRelated(a: string, b: string): boolean {
  if (a === b) return false;
  if (dirOf(a) === dirOf(b) && dirOf(a) !== "") return true;
  const stemA = familyStem(a);
  const stemB = familyStem(b);
  if (stemA.length > 0 && stemA === stemB) return true;
  const sfA = suffixFamily(a);
  const sfB = suffixFamily(b);
  if (sfA !== null && sfA === sfB) return true;
  return false;
}

// Tokenize a question into distinct lowercased terms: splits whitespace, path
// separators, punctuation, and camelCase; drops stop words and <=3 char noise.
function tokenizeQuestion(question: string): string[] {
  const tokens = new Set<string>();
  for (const raw of question.split(/[\s/\\.,;:()[\]{}'"`]+/)) {
    if (!raw) continue;
    const camelSplit = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/\s+/);
    for (const piece of [raw, ...camelSplit]) {
      const t = piece.toLowerCase();
      if (t.length > 3 && !STOP_WORDS.has(t)) tokens.add(t);
    }
  }
  return [...tokens];
}

export function rerankChunks(
  chunks: EnrichedContextChunk[],
  question: string,
  options?: RerankOptions,
): { chunks: EnrichedContextChunk[]; statistics: RerankStatistics } {
  const originalChunkCount = chunks.length;

  if (chunks.length === 0) {
    return {
      chunks: [],
      statistics: {
        originalChunkCount: 0,
        rerankedChunkCount: 0,
        duplicateChunksRemoved: 0,
        boostedChunkCount: 0,
        crossFileBoostedChunkCount: 0,
      },
    };
  }

  // STEP 1 — Score normalization into 0..1 (preserve relative ordering).
  const maxScore = chunks.reduce((m, c) => Math.max(m, c.score ?? 0), 0);
  const work = chunks.map((c) => ({
    chunk: { ...c, signals: { ...c.signals } },
    norm: maxScore > 0 ? clamp01((c.score ?? 0) / maxScore) : NEUTRAL_SCORE,
  }));

  // STEP 2 — Question keyword boosting.
  const tokens = tokenizeQuestion(question);
  let boostedChunkCount = 0;
  for (const item of work) {
    const content = item.chunk.content.toLowerCase();
    const filePath = item.chunk.filePath.toLowerCase();
    let boost = 0;

    let contentBoost = 0;
    for (const t of tokens) {
      if (content.includes(t)) contentBoost += BOOST_CONTENT_PER_TOKEN;
    }
    boost += Math.min(contentBoost, BOOST_CONTENT_CAP);

    if (tokens.some((t) => filePath.includes(t))) boost += BOOST_FILEPATH;

    const hasSymbolMatch = tokens.some((t) => {
      const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`);
      return re.test(content);
    });
    if (hasSymbolMatch) boost += BOOST_SYMBOL;

    if (boost > 0) boostedChunkCount += 1;
    item.norm = clamp01(item.norm + boost);
  }

  // STEP 3 — Duplicate suppression (filePath+startLine+endLine), keep highest.
  const byKey = new Map<string, (typeof work)[number]>();
  for (const item of work) {
    const key = `${item.chunk.filePath}:${item.chunk.startLine}:${item.chunk.endLine}`;
    const existing = byKey.get(key);
    if (!existing || item.norm > existing.norm) byKey.set(key, item);
  }
  const deduped = [...byKey.values()];
  const duplicateChunksRemoved = work.length - deduped.length;

  // STEP 3.5 — Cross-file relevance boosting.
  // Seeds: files whose post-boost score >= threshold (deterministic order:
  // score desc, filePath asc), capped at MAX_SEEDS. Related candidates must
  // already be present in the chunk list (we never fetch or create chunks).
  const candidateFiles = new Set(deduped.map((i) => i.chunk.filePath));

  const seedOrder = [...deduped].sort(
    (a, b) => b.norm - a.norm || a.chunk.filePath.localeCompare(b.chunk.filePath),
  );
  const seedFiles: string[] = [];
  for (const item of seedOrder) {
    if (item.norm < SEED_SCORE_THRESHOLD) continue;
    if (!seedFiles.includes(item.chunk.filePath)) seedFiles.push(item.chunk.filePath);
    if (seedFiles.length >= MAX_SEEDS) break;
  }
  const seedSet = new Set(seedFiles);

  // For each candidate file, count distinct seeds that relate to it.
  const seedsPerFile = new Map<string, number>();
  for (const seed of seedFiles) {
    const provided = options?.relatedFiles?.[seed];
    const related =
      provided !== undefined
        ? provided.filter((f) => candidateFiles.has(f))
        : [...candidateFiles].filter((f) => heuristicallyRelated(seed, f));
    for (const file of related) {
      if (seedSet.has(file)) continue; // never boost a seed's own file
      seedsPerFile.set(file, (seedsPerFile.get(file) ?? 0) + 1);
    }
  }

  let crossFileBoostedChunkCount = 0;
  for (const item of deduped) {
    const relatingSeeds = seedsPerFile.get(item.chunk.filePath);
    if (!relatingSeeds || seedSet.has(item.chunk.filePath)) continue;
    const boost = Math.min(
      CROSS_FILE_BOOST_PER_SEED * relatingSeeds,
      CROSS_FILE_BOOST_CAP,
    );
    if (boost > 0) {
      item.norm = clamp01(item.norm + boost);
      crossFileBoostedChunkCount += 1;
    }
  }

  // Stable pre-sort so diversity penalty applies in deterministic order.
  deduped.sort(
    (a, b) =>
      b.norm - a.norm ||
      a.chunk.filePath.localeCompare(b.chunk.filePath) ||
      a.chunk.startLine - b.chunk.startLine ||
      a.chunk.endLine - b.chunk.endLine,
  );

  // STEP 4 — Same-file diversity: soft additive penalty, never drop, floor 0.
  const perFile = new Map<string, number>();
  for (const item of deduped) {
    const seen = perFile.get(item.chunk.filePath) ?? 0;
    if (seen > 0) item.norm = clamp01(item.norm - DIVERSITY_PENALTY * seen);
    perFile.set(item.chunk.filePath, seen + 1);
  }

  // STEP 5 — Final stable ordering + clamp; write normalized score back.
  const finalChunks = deduped
    .map((item) => ({ ...item.chunk, score: clamp01(item.norm) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.filePath.localeCompare(b.filePath) ||
        a.startLine - b.startLine ||
        a.endLine - b.endLine,
    );

  return {
    chunks: finalChunks,
    statistics: {
      originalChunkCount,
      rerankedChunkCount: finalChunks.length,
      duplicateChunksRemoved,
      boostedChunkCount,
      crossFileBoostedChunkCount,
    },
  };
}
