import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabase.js";
import { env } from "../../config/env.js";
import {
  createProductionHealthCheck,
  type ProductionHealthCheck,
} from "./productionHealth.js";

type ProbeResult = { data: unknown; error: unknown };

async function checkSupabase(client: SupabaseClient): Promise<void> {
  const result = await client
    .from("repositories")
    .select("repository_id")
    .limit(1) as ProbeResult;
  if (result.error) throw new Error("Supabase health check failed.");
}

async function checkIndexingWorker(client: SupabaseClient): Promise<void> {
  const result = await client
    .from("indexing_workers")
    .select("heartbeat_at")
    .eq("shutdown_state", "running")
    .order("heartbeat_at", { ascending: false })
    .limit(1) as ProbeResult;
  const row = Array.isArray(result.data) ? result.data[0] : null;
  const heartbeat = row && typeof row === "object"
    ? (row as { heartbeat_at?: unknown }).heartbeat_at
    : null;
  const heartbeatMs = typeof heartbeat === "string" ? Date.parse(heartbeat) : Number.NaN;
  if (
    result.error ||
    !Number.isFinite(heartbeatMs) ||
    Date.now() - heartbeatMs > env.INDEXING_WORKER_STALE_CLAIM_MS
  ) {
    throw new Error("Indexing worker health check failed.");
  }
}

export function createRuntimeProductionHealthCheck(options: {
  client?: SupabaseClient;
  timeoutMs?: number;
} = {}): ProductionHealthCheck {
  const client = options.client ?? supabase;
  return createProductionHealthCheck({
    checkSupabase: () => checkSupabase(client),
    checkIndexingWorker: () => checkIndexingWorker(client),
  }, options.timeoutMs);
}
