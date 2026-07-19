// Persists repository summaries to Supabase. Degrades gracefully if the table
// is missing so summary generation never hard-fails on a missing migration.

import { supabase } from "../../lib/supabase.js";
import { logger } from "../../lib/logger.js";
import type { RepositorySummary } from "./types.js";

const TABLE = "repository_summaries";

export interface SummaryStoreOptions {
  repositoryRevision?: string;
  databaseClient?: typeof supabase;
}

export async function saveSummary(
  summary: RepositorySummary,
  options: SummaryStoreOptions = {},
): Promise<void> {
  const repositoryRevision = options.repositoryRevision ?? "unversioned";
  const { error } = await (options.databaseClient ?? supabase)
    .from(TABLE)
    .upsert(
      {
        repository: summary.repository,
        repository_revision: repositoryRevision,
        summary_kind: "intelligence",
        summary,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "repository,repository_revision,summary_kind" },
    );

  if (error) {
    logger.warn("summary_persist_failed", {
      repository: summary.repository,
      message: error.message,
    });
  }
}

export async function loadSummary(
  repository: string,
  options: SummaryStoreOptions = {},
): Promise<RepositorySummary | null> {
  let query = (options.databaseClient ?? supabase)
    .from(TABLE)
    .select("summary")
    .eq("repository", repository)
    .eq("summary_kind", "intelligence");
  if (options.repositoryRevision) {
    query = query.eq("repository_revision", options.repositoryRevision);
  }
  const { data, error } = await query
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return (data as { summary: RepositorySummary }).summary;
}
