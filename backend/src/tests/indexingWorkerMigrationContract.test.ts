import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SupabaseIndexingJobStore } from "../services/indexing/jobs/supabaseIndexingJobStore.js";

const MIGRATION = new URL(
  "../../supabase/migrations/20260715000000_create_supervised_indexing_worker.sql",
  import.meta.url,
);

test("migration provisions atomic claim, retry, recovery, heartbeat, and health contracts", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  for (const contract of [
    "for update skip locked",
    "claim_next_indexing_job",
    "heartbeat_indexing_job",
    "schedule_indexing_job_retry",
    "recover_stale_indexing_jobs",
    "record_indexing_worker_state",
    "next_retry_at",
    "recovery_count",
    "indexing_workers",
  ]) assert.match(sql.toLowerCase(), new RegExp(contract.replaceAll("_", "_")));
  assert.match(sql, /revoke all on table public\.indexing_workers from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.claim_next_indexing_job\(text\) to service_role/i);
});

test("runtime worker uses Supabase stores and the canonical one-job executor", async () => {
  const [command, runtimeStore] = await Promise.all([
    readFile(new URL("../commands/runIndexingWorker.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/indexing/jobs/runtimeIndexingJobStore.ts", import.meta.url), "utf8"),
  ]);
  assert.match(command, /processNextIndexingJob/);
  assert.match(command, /SupabaseIndexingWorkerStateStore/);
  assert.doesNotMatch(command, /MemoryIndexingJobStore/);
  assert.match(runtimeStore, /SupabaseIndexingJobStore/);
  assert.doesNotMatch(runtimeStore, /MemoryIndexingJobStore/);
});

test("supervision adapter uses the authoritative RPC input contracts", async () => {
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const client = {
    from: () => { throw new Error("unexpected table query"); },
    rpc: async (name: string, parameters: Record<string, unknown>) => {
      calls.push({ name, parameters });
      return { data: name === "heartbeat_indexing_job" ? true : [], error: null };
    },
  };
  const store = new SupabaseIndexingJobStore({ client });
  assert.equal(await store.heartbeatJob("job-1", "worker-1"), true);
  assert.equal(await store.scheduleRetry(
    "job-1", "worker-1",
    { code: "clone_failed", message: "Repository clone failed.", retryable: true },
    5_000,
  ), null);
  assert.deepEqual(await store.recoverStaleJobs({
    staleBefore: "2026-07-19T00:00:00.000Z",
    retryDelayMs: 5_000,
  }), []);
  assert.deepEqual(calls.map((call) => call.name), [
    "heartbeat_indexing_job",
    "schedule_indexing_job_retry",
    "recover_stale_indexing_jobs",
  ]);
  assert.equal(calls[1]?.parameters.input_delay_ms, 5_000);
  assert.equal(calls[2]?.parameters.input_stale_before, "2026-07-19T00:00:00.000Z");
});
