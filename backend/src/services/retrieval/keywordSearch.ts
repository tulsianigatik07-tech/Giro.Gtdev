// Keyword retrieval over repository_chunks via ilike, scored locally.

import { supabase } from "../../lib/supabase.js";
import { logger } from "../../lib/logger.js";
import type { RetrievalResult } from "./types.js";
import { env } from "../../config/env.js";
import { createDeadline, isDeadlineExceeded } from "../../runtime/deadline.js";

interface ChunkRow {
  repository: string;
  file_path: string;
  language: string;
  content: string;
  start_line: number;
  end_line: number;
}

export async function keywordSearch(
  query: string,
  owner: string,
  repo: string,
  limit: number = 20,
  options: { signal?: AbortSignal } = {},
): Promise<RetrievalResult[]> {
  const repository = `${owner}/${repo}`;
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);

  if (tokens.length === 0) return [];

  const orFilter = tokens
    .map((t) => `content.ilike.%${t}%,file_path.ilike.%${t}%`)
    .join(",");

  let rows: ChunkRow[];
  const deadline = createDeadline(env.DATABASE_REQUEST_TIMEOUT_MS, { parentSignal: options.signal });
  try {
    const { data, error } = await supabase
      .from("repository_chunks")
      .select("repository,file_path,language,content,start_line,end_line")
      .eq("repository", repository)
      .or(orFilter)
      .limit(limit * 3)
      .abortSignal(deadline.signal);
    if (deadline.signal.aborted) throw deadline.signal.reason;
    if (error) throw new Error(error.message);
    rows = (data ?? []) as ChunkRow[];
  } catch (err) {
    if (isDeadlineExceeded(err)) throw err;
    logger.error("keyword_search_failed", {
      repository,
      message: err instanceof Error ? err.message : "unknown",
    });
    return [];
  } finally {
    deadline.dispose();
  }

  const phrase = query.toLowerCase().trim();
  const scored = rows.map((row) => {
    const content = row.content.toLowerCase();
    const filePath = row.file_path.toLowerCase();
    let raw = 0;
    for (const token of tokens) {
      if (content.includes(token)) raw += 1.0;
      if (filePath.includes(token)) raw += 1.5;
    }
    if (phrase.length > 0 && content.includes(phrase)) raw += 2.0;
    return { row, raw };
  });

  const maxRaw = scored.reduce((m, s) => (s.raw > m ? s.raw : m), 0) || 1;

  return scored
    .filter((s) => s.raw > 0)
    .map((s) => ({
      repository: s.row.repository,
      filePath: s.row.file_path,
      language: s.row.language,
      content: s.row.content,
      startLine: s.row.start_line,
      endLine: s.row.end_line,
      score: Math.min(1, s.raw / maxRaw),
      source: "keyword" as const,
      signals: { keyword: Math.min(1, s.raw / maxRaw) },
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.filePath.localeCompare(b.filePath) ||
        a.startLine - b.startLine,
    )
    .slice(0, limit);
}
