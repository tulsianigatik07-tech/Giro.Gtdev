// Deterministic retrieval blind-spot analysis: sources or file extensions
// underrepresented (absent) in the final retrieval result. Metadata ONLY —
// never affects retrieval, reranking, confidence, explainability, coverage,
// hotspots, diversity, budgeting, prompts, or answers. No AI, no randomness,
// no timestamps. Inputs are never mutated. Never exposes raw chunk content.

import type { EnrichedContextChunk } from "../context/contextTypes.js";

export interface RetrievalBlindSpot {
  type: "source" | "file-extension";
  name: string;
  expectedMinimum: number;
  actualCount: number;
  severity: "low" | "medium" | "high";
}

export interface RetrievalBlindSpots {
  blindSpots: RetrievalBlindSpot[];
  blindSpotCount: number;
  hasBlindSpots: boolean;
}

const MIN_CHUNKS_FOR_ANALYSIS = 5;
const HIGH_SEVERITY_THRESHOLD = 10;

// Real chunk.source literals (see contextTypes.ts): note "file-search".
const KNOWN_SOURCES = ["semantic", "keyword", "symbol", "graph", "file-search"];
const KNOWN_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".json", ".md"];

const SEVERITY_ORDER: Record<RetrievalBlindSpot["severity"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function extensionOf(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  const base = lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return ""; // no extension (or dotfile with no ext)
  return base.slice(dot).toLowerCase();
}

export function buildRetrievalBlindSpots(
  chunks: EnrichedContextChunk[],
): RetrievalBlindSpots {
  const totalChunks = chunks.length;

  if (totalChunks < MIN_CHUNKS_FOR_ANALYSIS) {
    return { blindSpots: [], blindSpotCount: 0, hasBlindSpots: false };
  }

  const sourceCounts = new Map<string, number>();
  const extCounts = new Map<string, number>();
  for (const chunk of chunks) {
    sourceCounts.set(chunk.source, (sourceCounts.get(chunk.source) ?? 0) + 1);
    const ext = extensionOf(chunk.filePath);
    if (ext !== "") extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
  }

  const severity: RetrievalBlindSpot["severity"] =
    totalChunks >= HIGH_SEVERITY_THRESHOLD ? "high" : "medium";

  const blindSpots: RetrievalBlindSpot[] = [];

  for (const source of KNOWN_SOURCES) {
    if ((sourceCounts.get(source) ?? 0) === 0) {
      blindSpots.push({
        type: "source",
        name: source,
        expectedMinimum: 1,
        actualCount: 0,
        severity,
      });
    }
  }

  for (const ext of KNOWN_EXTENSIONS) {
    if ((extCounts.get(ext) ?? 0) === 0) {
      blindSpots.push({
        type: "file-extension",
        name: ext,
        expectedMinimum: 1,
        actualCount: 0,
        severity,
      });
    }
  }

  blindSpots.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.type.localeCompare(b.type) ||
      a.name.localeCompare(b.name),
  );

  return {
    blindSpots,
    blindSpotCount: blindSpots.length,
    hasBlindSpots: blindSpots.length > 0,
  };
}
