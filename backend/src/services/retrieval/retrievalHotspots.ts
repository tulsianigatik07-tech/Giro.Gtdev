// Deterministic retrieval hotspot analysis: flags whether retrieval is overly
// concentrated in one or a few files. Metadata ONLY — never affects retrieval,
// reranking, confidence, explainability, coverage, budgeting, or answers.
// No AI, no randomness, no timestamps. Inputs are never mutated. Never exposes
// raw chunk content.

import type { EnrichedContextChunk } from "../context/contextTypes.js";

export interface RetrievalHotspotFile {
  filePath: string;
  chunkCount: number;
  percentage: number;
  severity: "low" | "medium" | "high";
}

export interface RetrievalHotspots {
  hotspotFiles: RetrievalHotspotFile[];
  hotspotCount: number;
  dominantHotspot?: RetrievalHotspotFile;
  concentrationLevel: "balanced" | "moderate" | "concentrated";
}

const HOTSPOT_MIN_PERCENT = 20;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function severityFor(percentage: number): "low" | "medium" | "high" {
  if (percentage >= 50) return "high";
  if (percentage >= 30) return "medium";
  return "low";
}

export function buildRetrievalHotspots(
  chunks: EnrichedContextChunk[],
): RetrievalHotspots {
  const totalChunks = chunks.length;

  if (totalChunks === 0) {
    return {
      hotspotFiles: [],
      hotspotCount: 0,
      dominantHotspot: undefined,
      concentrationLevel: "balanced",
    };
  }

  const countByFile = new Map<string, number>();
  for (const chunk of chunks) {
    countByFile.set(chunk.filePath, (countByFile.get(chunk.filePath) ?? 0) + 1);
  }

  // Top percentage across ALL files (drives concentrationLevel).
  let topPercentage = 0;
  for (const count of countByFile.values()) {
    const pct = (count / totalChunks) * 100;
    if (pct > topPercentage) topPercentage = pct;
  }

  const concentrationLevel: RetrievalHotspots["concentrationLevel"] =
    topPercentage >= 50 ? "concentrated" : topPercentage >= 30 ? "moderate" : "balanced";

  const hotspotFiles: RetrievalHotspotFile[] = [...countByFile.entries()]
    .map(([filePath, chunkCount]) => {
      const percentage = round3((chunkCount / totalChunks) * 100);
      return { filePath, chunkCount, percentage, severity: severityFor(percentage) };
    })
    .filter((f) => f.percentage >= HOTSPOT_MIN_PERCENT)
    .sort(
      (a, b) =>
        b.percentage - a.percentage ||
        b.chunkCount - a.chunkCount ||
        a.filePath.localeCompare(b.filePath),
    );

  return {
    hotspotFiles,
    hotspotCount: hotspotFiles.length,
    dominantHotspot: hotspotFiles[0],
    concentrationLevel,
  };
}
