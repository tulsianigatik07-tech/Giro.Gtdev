import type { SupabaseClient } from "@supabase/supabase-js";

export type IndexingWorkerShutdownState = "running" | "stopping" | "stopped";

export interface IndexingWorkerHealthUpdate {
  workerId: string;
  state: IndexingWorkerShutdownState;
  activeJobId?: string | null;
  lastCompletedJobId?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  polled?: boolean;
}

export interface IndexingWorkerStateStore {
  record(update: IndexingWorkerHealthUpdate): Promise<void>;
}

interface RpcClient {
  rpc(name: string, parameters: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message?: string } | null;
  }>;
}

export class SupabaseIndexingWorkerStateStore implements IndexingWorkerStateStore {
  private readonly client: RpcClient;

  constructor(client: RpcClient | SupabaseClient) {
    this.client = client as RpcClient;
  }

  async record(update: IndexingWorkerHealthUpdate): Promise<void> {
    const { error } = await this.client.rpc("record_indexing_worker_state", {
      input_worker_id: update.workerId,
      input_shutdown_state: update.state,
      input_active_job_id: update.activeJobId ?? null,
      input_last_completed_job_id: update.lastCompletedJobId ?? null,
      input_last_error_code: update.lastErrorCode ?? null,
      input_last_error_message: update.lastErrorMessage ?? null,
      input_polled: update.polled ?? false,
    });
    if (error) throw new Error("Indexing worker health persistence failed.");
  }
}
