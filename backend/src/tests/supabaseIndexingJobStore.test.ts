import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { createApp } from "../app.js";
import { runProcessNextIndexingJobCommand } from "../commands/processNextIndexingJob.js";
import { signAccessToken } from "../services/auth/jwt.js";
import type { IndexingJobPersistenceRow } from "../services/indexing/jobs/indexingJobPersistenceMapper.js";
import {
  IndexingJobPersistenceError,
  SupabaseIndexingJobStore,
  normalizeIndexingJobPersistenceError,
  type SupabaseErrorLike,
  type SupabaseIndexingJobClient,
  type SupabaseIndexingJobQuery,
  type SupabaseQueryResult,
} from "../services/indexing/jobs/supabaseIndexingJobStore.js";
import type {
  CreateIndexingJobInput,
  IndexingJobFailure,
} from "../services/indexing/jobs/indexingJobStore.js";
import type { IndexingJobRepositoryStore } from "../services/indexing/jobs/indexingJobWorker.js";
import {
  clearRepositoryIndexRegistry,
} from "../services/repository/indexingService.js";
import {
  clearRepositoryOwners,
} from "../services/repository/ownershipStore.js";

const BASE_INPUT: CreateIndexingJobInput = {
  repositoryId: "acme/demo",
  ownerUserId: "user-1",
  repositoryOwner: "acme",
  repositoryName: "demo",
  repositoryUrl: "https://github.com/acme/demo",
  branch: "main",
};

const FAILURE: IndexingJobFailure = {
  code: "indexing_failed",
  message: "Repository indexing failed.",
  retryable: true,
};

type Filter = {
  operator: "eq" | "gte";
  column: keyof IndexingJobPersistenceRow;
  value: unknown;
};

type Ordering = {
  column: keyof IndexingJobPersistenceRow;
  ascending: boolean;
};

type QueryOperation = "select" | "insert" | "update" | "delete";

class FakeQuery implements SupabaseIndexingJobQuery {
  private operation: QueryOperation = "select";
  private values: unknown = null;
  private readonly filters: Filter[] = [];
  private readonly orderings: Ordering[] = [];
  private maxRows: number | null = null;
  private single = false;
  private returning = false;

  constructor(private readonly client: FakeSupabaseClient) {}

  select(): SupabaseIndexingJobQuery {
    if (this.operation !== "select") this.returning = true;
    return this;
  }

  insert(values: unknown): SupabaseIndexingJobQuery {
    this.operation = "insert";
    this.values = values;
    return this;
  }

  update(values: unknown): SupabaseIndexingJobQuery {
    this.operation = "update";
    this.values = values;
    return this;
  }

  delete(): SupabaseIndexingJobQuery {
    this.operation = "delete";
    return this;
  }

  eq(column: string, value: unknown): SupabaseIndexingJobQuery {
    this.filters.push({
      operator: "eq",
      column: column as keyof IndexingJobPersistenceRow,
      value,
    });
    return this;
  }

  gte(column: string, value: unknown): SupabaseIndexingJobQuery {
    this.filters.push({
      operator: "gte",
      column: column as keyof IndexingJobPersistenceRow,
      value,
    });
    return this;
  }

  order(
    column: string,
    options?: { ascending?: boolean },
  ): SupabaseIndexingJobQuery {
    this.orderings.push({
      column: column as keyof IndexingJobPersistenceRow,
      ascending: options?.ascending ?? true,
    });
    return this;
  }

  limit(count: number): SupabaseIndexingJobQuery {
    this.maxRows = count;
    return this;
  }

  maybeSingle(): PromiseLike<SupabaseQueryResult> {
    this.single = true;
    return this;
  }

  then<TResult1 = SupabaseQueryResult, TResult2 = never>(
    onfulfilled?: ((value: SupabaseQueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<SupabaseQueryResult> {
    return this.client.executeQuery({
      operation: this.operation,
      values: this.values,
      filters: this.filters,
      orderings: this.orderings,
      maxRows: this.maxRows,
      single: this.single,
      returning: this.returning,
    });
  }
}

class FakeSupabaseClient implements SupabaseIndexingJobClient {
  readonly calls: Array<{ kind: "from" | "rpc"; name: string; parameters?: unknown }> = [];
  readonly rows: IndexingJobPersistenceRow[] = [];
  nextError: SupabaseErrorLike | null = null;
  nextThrownError: unknown = null;
  private nextSequence = 1;
  private nextOrder = 1;

  from(table: string): SupabaseIndexingJobQuery {
    this.calls.push({ kind: "from", name: table });
    return new FakeQuery(this);
  }

  rpc(
    functionName: string,
    parameters?: Record<string, unknown>,
  ): PromiseLike<SupabaseQueryResult> {
    this.calls.push({ kind: "rpc", name: functionName, parameters });
    return this.executeRpc(functionName, parameters ?? {});
  }

  seed(...rows: IndexingJobPersistenceRow[]): void {
    this.rows.push(...rows.map((item) => structuredClone(item)));
    this.nextSequence = Math.max(this.nextSequence, ...rows.map((item) => item.sequence + 1));
    const orders = rows.flatMap((item) => [
      item.created_order,
      item.started_order ?? 0,
      item.completed_order ?? 0,
    ]);
    this.nextOrder = Math.max(this.nextOrder, ...orders.map((item) => item + 1));
  }

  async executeQuery(input: {
    operation: QueryOperation;
    values: unknown;
    filters: Filter[];
    orderings: Ordering[];
    maxRows: number | null;
    single: boolean;
    returning: boolean;
  }): Promise<SupabaseQueryResult> {
    const failure = this.takeFailure();
    if (failure) return failure;

    let matches = this.rows.filter((item) => input.filters.every((filter) => {
      const value = item[filter.column];
      if (filter.operator === "eq") return value === filter.value;
      return typeof value === "number" && typeof filter.value === "number"
        && value >= filter.value;
    }));
    matches = this.sort(matches, input.orderings);
    if (input.maxRows !== null) matches = matches.slice(0, input.maxRows);

    if (input.operation === "update") {
      const patch = input.values as Partial<IndexingJobPersistenceRow>;
      matches.forEach((item) => {
        Object.assign(item, structuredClone(patch));
        if (
          ["succeeded", "failed", "cancelled"].includes(item.status)
          && item.completed_order === null
        ) {
          item.completed_order = this.nextOrder++;
        }
        item.updated_at = "2026-07-11T00:00:01.000Z";
      });
    } else if (input.operation === "delete") {
      const selected = new Set(matches);
      for (let index = this.rows.length - 1; index >= 0; index -= 1) {
        const candidate = this.rows[index];
        if (candidate && selected.has(candidate)) this.rows.splice(index, 1);
      }
    } else if (input.operation === "insert") {
      const values = Array.isArray(input.values) ? input.values : [input.values];
      matches = values.map((value) => value as IndexingJobPersistenceRow);
      this.seed(...matches);
    }

    const data = input.operation === "select" || input.returning
      ? matches.map((item) => structuredClone(item))
      : null;
    if (input.single) {
      const items = data as IndexingJobPersistenceRow[] | null;
      return { data: items?.[0] ?? null, error: null };
    }
    return { data, error: null };
  }

  private async executeRpc(
    functionName: string,
    parameters: Record<string, unknown>,
  ): Promise<SupabaseQueryResult> {
    const failure = this.takeFailure();
    if (failure) return failure;

    if (functionName === "create_indexing_job") {
      const repositoryId = parameters.input_repository_id as string;
      const active = this.sort(
        this.rows.filter((item) =>
          item.repository_id === repositoryId
          && ["queued", "claimed", "running"].includes(item.status)),
        [
          { column: "created_order", ascending: true },
          { column: "sequence", ascending: true },
          { column: "job_id", ascending: true },
        ],
      )[0];
      if (active) return { data: [structuredClone(active)], error: null };

      const sequence = this.nextSequence++;
      const timestamp = "2026-07-11T00:00:00.000Z";
      const created: IndexingJobPersistenceRow = {
        job_id: `indexing-job-${sequence}`,
        repository_id: repositoryId,
        owner_user_id: parameters.input_owner_user_id as string,
        repository_owner: parameters.input_repository_owner as string,
        repository_name: parameters.input_repository_name as string,
        repository_url: parameters.input_repository_url as string,
        branch: parameters.input_branch as string | null,
        status: "queued",
        sequence,
        attempt: 1,
        max_attempts: parameters.input_max_attempts as number,
        progress: 0,
        current_stage: "pending",
        failure_code: null,
        failure_message: null,
        failure_retryable: null,
        claimed_by: null,
        created_order: this.nextOrder++,
        started_order: null,
        completed_order: null,
        request_id: parameters.input_request_id as string | null,
        traceparent: parameters.input_traceparent as string | null,
        created_at: timestamp,
        updated_at: timestamp,
      };
      this.rows.push(created);
      return { data: [structuredClone(created)], error: null };
    }

    if (functionName === "claim_next_indexing_job") {
      const queued = this.sort(
        this.rows.filter((item) => item.status === "queued"),
        [
          { column: "created_order", ascending: true },
          { column: "sequence", ascending: true },
          { column: "job_id", ascending: true },
        ],
      )[0];
      if (!queued) return { data: [], error: null };
      queued.status = "claimed";
      queued.claimed_by = parameters.input_worker_id as string;
      queued.claim_token = `claim-token-${this.nextOrder}`;
      queued.started_order = this.nextOrder++;
      queued.lease_expires_at = "2026-07-11T00:05:00.000Z";
      return { data: [structuredClone(queued)], error: null };
    }

    const fenced = this.rows.find((item) =>
      item.job_id === parameters.input_job_id
      && item.claimed_by === parameters.input_worker_id
      && item.claim_token === parameters.input_claim_token
    );
    if (functionName === "mark_indexing_job_running") {
      if (!fenced || fenced.status !== "claimed") return { data: [], error: null };
      fenced.status = "running";
      fenced.current_stage = parameters.input_stage as IndexingJobPersistenceRow["current_stage"];
      return { data: [structuredClone(fenced)], error: null };
    }
    if (functionName === "update_indexing_job_progress") {
      if (!fenced || fenced.status !== "running") return { data: [], error: null };
      fenced.progress = parameters.input_progress as number;
      fenced.current_stage = parameters.input_stage as IndexingJobPersistenceRow["current_stage"];
      return { data: [structuredClone(fenced)], error: null };
    }
    if (functionName === "complete_indexing_job") {
      if (!fenced || fenced.status !== "running") return { data: [], error: null };
      fenced.status = "succeeded";
      fenced.progress = 100;
      fenced.current_stage = "complete";
      fenced.completed_order = this.nextOrder++;
      return { data: [structuredClone(fenced)], error: null };
    }
    if (functionName === "fail_indexing_job") {
      if (!fenced || !["claimed", "running"].includes(fenced.status)) {
        return { data: [], error: null };
      }
      fenced.status = "failed";
      fenced.failure_code = parameters.input_failure_code as string;
      fenced.failure_message = parameters.input_failure_message as string;
      fenced.failure_retryable = parameters.input_failure_retryable as boolean;
      fenced.completed_order = this.nextOrder++;
      return { data: [structuredClone(fenced)], error: null };
    }

    return { data: null, error: { code: "42883", message: "unknown rpc" } };
  }

  private takeFailure(): SupabaseQueryResult | null {
    if (this.nextThrownError) {
      const error = this.nextThrownError;
      this.nextThrownError = null;
      throw error;
    }
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      return { data: null, error };
    }
    return null;
  }

  private sort(
    input: IndexingJobPersistenceRow[],
    orderings: Ordering[],
  ): IndexingJobPersistenceRow[] {
    return [...input].sort((left, right) => {
      for (const ordering of orderings) {
        const leftValue = left[ordering.column];
        const rightValue = right[ordering.column];
        const compared = typeof leftValue === "number" && typeof rightValue === "number"
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue));
        if (compared !== 0) return ordering.ascending ? compared : -compared;
      }
      return 0;
    });
  }
}

let client: FakeSupabaseClient;
let store: SupabaseIndexingJobStore;

function persistedRow(
  overrides: Partial<IndexingJobPersistenceRow> = {},
): IndexingJobPersistenceRow {
  return {
    job_id: "indexing-job-1",
    repository_id: "acme/demo",
    owner_user_id: "user-1",
    repository_owner: "acme",
    repository_name: "demo",
    repository_url: "https://github.com/acme/demo",
    branch: "main",
    status: "queued",
    sequence: 1,
    attempt: 1,
    max_attempts: 3,
    progress: 0,
    current_stage: "pending",
    failure_code: null,
    failure_message: null,
    failure_retryable: null,
    claimed_by: null,
    created_order: 1,
    started_order: null,
    completed_order: null,
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  client = new FakeSupabaseClient();
  store = new SupabaseIndexingJobStore({ client });
  clearRepositoryOwners();
  clearRepositoryIndexRegistry();
});

test("creates a queued job through the database-owned create RPC", async () => {
  const created = await store.createJob(BASE_INPUT);

  assert.equal(created.jobId, "indexing-job-1");
  assert.equal(created.repositoryId, "acme/demo");
  assert.equal(created.status, "queued");
  assert.equal(created.sequence, 1);
  assert.equal(created.createdOrder, 1);
  assert.deepEqual(client.calls[0], {
    kind: "rpc",
    name: "create_indexing_job",
    parameters: {
      input_repository_id: "acme/demo",
      input_owner_user_id: "user-1",
      input_repository_owner: "acme",
      input_repository_name: "demo",
      input_repository_url: "https://github.com/acme/demo",
      input_branch: "main",
      input_max_attempts: 3,
      input_request_id: null,
      input_traceparent: null,
    },
  });
});

test("persists optional request correlation through the creation RPC", async () => {
  const created = await store.createJob({
    ...BASE_INPUT,
    createdByRequestId: "request-123",
  });

  assert.equal(created.createdByRequestId, "request-123");
  assert.equal(
    (client.calls[0]?.parameters as Record<string, unknown>).input_request_id,
    "request-123",
  );
});

test("persists trace context through the creation RPC", async () => {
  const traceparent = "00-11111111111111111111111111111111-2222222222222222-01";
  const created = await store.createJob({
    ...BASE_INPUT,
    createdByTraceparent: traceparent,
  });

  assert.equal(created.createdByTraceparent, traceparent);
  assert.equal(
    (client.calls[0]?.parameters as Record<string, unknown>).input_traceparent,
    traceparent,
  );
});

test("gets a job and returns null for an unknown job", async () => {
  client.seed(persistedRow());

  assert.equal((await store.getJob("indexing-job-1"))?.repositoryId, "acme/demo");
  assert.equal(await store.getJob("indexing-job-404"), null);
});

test("lists jobs with filters in deterministic created order", async () => {
  client.seed(
    persistedRow({ job_id: "indexing-job-2", sequence: 2, created_order: 2 }),
    persistedRow({
      job_id: "indexing-job-1",
      repository_id: "acme/other",
      repository_name: "other",
      repository_url: "https://github.com/acme/other",
      sequence: 1,
      created_order: 1,
    }),
    persistedRow({
      job_id: "indexing-job-3",
      repository_id: "other/demo",
      repository_owner: "other",
      owner_user_id: "user-2",
      sequence: 3,
      created_order: 3,
    }),
  );

  assert.deepEqual(
    (await store.listJobs({ ownerUserId: "user-1" })).map((job) => job.jobId),
    ["indexing-job-1", "indexing-job-2"],
  );
  assert.deepEqual(
    (await store.listJobs({ repositoryId: "acme/demo", status: "queued" }))
      .map((job) => job.jobId),
    ["indexing-job-2"],
  );
});

test("lists repository history and returns the latest job", async () => {
  client.seed(
    persistedRow(),
    persistedRow({ job_id: "indexing-job-2", sequence: 2, created_order: 4 }),
    persistedRow({
      job_id: "indexing-job-3",
      repository_id: "acme/other",
      repository_name: "other",
      sequence: 3,
      created_order: 5,
    }),
  );

  assert.deepEqual(
    (await store.listRepositoryJobs("acme/demo")).map((job) => job.jobId),
    ["indexing-job-1", "indexing-job-2"],
  );
  assert.equal((await store.getLatestRepositoryJob("acme/demo"))?.jobId, "indexing-job-2");
  assert.equal(await store.getLatestRepositoryJob("missing/repo"), null);
});

test("atomic claim uses RPC and idle claim returns null", async () => {
  client.seed(persistedRow());

  const claimed = await store.claimNextJob("worker-1");
  const idle = await store.claimNextJob("worker-2");

  assert.equal(claimed?.status, "claimed");
  assert.equal(claimed?.claimedBy, "worker-1");
  assert.equal(idle, null);
  assert.deepEqual(
    client.calls.filter((call) => call.kind === "rpc").map((call) => call.name),
    ["claim_next_indexing_job", "claim_next_indexing_job"],
  );
  assert.equal(client.calls.some((call) => call.kind === "from"), false);
});

test("two claim requests never receive the same mocked job", async () => {
  client.seed(
    persistedRow(),
    persistedRow({
      job_id: "indexing-job-2",
      repository_id: "acme/second",
      repository_name: "second",
      repository_url: "https://github.com/acme/second",
      sequence: 2,
      created_order: 2,
    }),
  );

  const claims = await Promise.all([
    store.claimNextJob("worker-1"),
    store.claimNextJob("worker-2"),
    store.claimNextJob("worker-3"),
  ]);
  const ids = claims.filter((job) => job !== null).map((job) => job.jobId);

  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ["indexing-job-1", "indexing-job-2"]);
  assert.equal(claims[2], null);
});

test("marks claimed job running and updates progress", async () => {
  client.seed(persistedRow({
    status: "claimed",
    claimed_by: "worker-1",
    started_order: 2,
  }));

  const running = await store.markRunning("indexing-job-1", "clone");
  const progressed = await store.updateProgress("indexing-job-1", 25, "scan");

  assert.equal(running?.status, "running");
  assert.equal(running?.currentStage, "clone");
  assert.equal(progressed?.progress, 25);
  assert.equal(progressed?.currentStage, "scan");
});

test("rejects progress decrease without issuing an update", async () => {
  client.seed(persistedRow({
    status: "running",
    progress: 40,
    current_stage: "structure",
    claimed_by: "worker-1",
    started_order: 2,
  }));

  const result = await store.updateProgress("indexing-job-1", 39, "scan");

  assert.equal(result, null);
  assert.equal((await store.getJob("indexing-job-1"))?.progress, 40);
  assert.equal(client.calls.filter((call) => call.kind === "from").length, 2);
});

test("marks running job succeeded with database-owned completion order", async () => {
  client.seed(persistedRow({
    status: "running",
    progress: 95,
    current_stage: "finalize",
    claimed_by: "worker-1",
    started_order: 2,
  }));

  const succeeded = await store.markSucceeded("indexing-job-1");

  assert.equal(succeeded?.status, "succeeded");
  assert.equal(succeeded?.progress, 100);
  assert.equal(succeeded?.currentStage, "complete");
  assert.notEqual(succeeded?.completedOrder, null);
});

test("marks running job failed with structured failure", async () => {
  client.seed(persistedRow({
    status: "running",
    progress: 25,
    current_stage: "scan",
    claimed_by: "worker-1",
    started_order: 2,
  }));

  const failed = await store.markFailed("indexing-job-1", FAILURE);

  assert.equal(failed?.status, "failed");
  assert.deepEqual(failed?.failure, FAILURE);
  assert.notEqual(failed?.completedOrder, null);
});

test("cancels queued job and rejects invalid terminal transition", async () => {
  client.seed(persistedRow());
  const cancelled = await store.cancelJob("indexing-job-1");

  assert.equal(cancelled?.status, "cancelled");
  assert.notEqual(cancelled?.completedOrder, null);
  assert.equal(await store.markRunning("indexing-job-1"), null);
});

test("deletes known job, reports unknown delete, and clears all jobs", async () => {
  client.seed(
    persistedRow(),
    persistedRow({ job_id: "indexing-job-2", sequence: 2, created_order: 2 }),
  );

  assert.equal(await store.deleteJob("indexing-job-1"), true);
  assert.equal(await store.deleteJob("indexing-job-404"), false);
  await store.clear();

  assert.deepEqual(await store.listJobs(), []);
});

test("unknown jobs follow the existing null store contract", async () => {
  assert.equal(await store.updateJob("missing", { progress: 10 }), null);
  assert.equal(await store.markRunning("missing"), null);
  assert.equal(await store.markSucceeded("missing"), null);
  assert.equal(await store.markFailed("missing", FAILURE), null);
  assert.equal(await store.cancelJob("missing"), null);
});

test("duplicate active repository job deterministically returns existing job", async () => {
  const first = await store.createJob(BASE_INPUT);
  const duplicate = await store.createJob(BASE_INPUT);

  assert.deepEqual(duplicate, first);
  assert.equal(client.rows.length, 1);
});

test("normalizes duplicate, invalid transition, unavailable, and unknown errors", () => {
  assert.equal(normalizeIndexingJobPersistenceError({ code: "23505" }).code, "duplicate_active_job");
  assert.equal(normalizeIndexingJobPersistenceError({ code: "PGRST116" }).code, "job_not_found");
  assert.equal(normalizeIndexingJobPersistenceError({ code: "23514" }).code, "invalid_transition");
  assert.equal(normalizeIndexingJobPersistenceError({ code: "08006" }).code, "supabase_unavailable");
  assert.equal(normalizeIndexingJobPersistenceError({ code: "XX000" }).code, "database_failure");
});

test("Supabase unavailable error is stable and does not leak raw details", async () => {
  client.nextThrownError = new Error(
    "fetch failed https://secret-project.supabase.co?service_key=hidden\nstack trace",
  );

  await assert.rejects(
    () => store.createJob(BASE_INPUT),
    (error: unknown) => {
      assert.ok(error instanceof IndexingJobPersistenceError);
      assert.equal(error.code, "supabase_unavailable");
      assert.equal(error.message, "Indexing job persistence is unavailable.");
      assert.equal(error.message.includes("supabase.co"), false);
      assert.equal(error.message.includes("stack"), false);
      return true;
    },
  );
});

test("raw Supabase errors are normalized without payload leakage", async () => {
  client.nextError = {
    code: "XX000",
    message: "SQL select * service-role-key=hidden",
  };

  await assert.rejects(
    () => store.listJobs(),
    (error: unknown) => {
      assert.ok(error instanceof IndexingJobPersistenceError);
      assert.equal(error.code, "database_failure");
      assert.equal(error.message, "Indexing job persistence failed.");
      assert.equal(error.message.includes("select"), false);
      assert.equal(error.message.includes("hidden"), false);
      return true;
    },
  );
});

test("returned jobs and failures are defensive objects", async () => {
  client.seed(persistedRow({
    status: "failed",
    progress: 25,
    current_stage: "scan",
    claimed_by: "worker-1",
    started_order: 2,
    completed_order: 3,
    failure_code: FAILURE.code,
    failure_message: FAILURE.message,
    failure_retryable: FAILURE.retryable,
  }));

  const first = await store.getJob("indexing-job-1");
  assert.ok(first?.failure);
  first.repositoryName = "mutated";
  first.failure.message = "mutated";
  const second = await store.getJob("indexing-job-1");

  assert.equal(second?.repositoryName, "demo");
  assert.equal(second?.failure?.message, FAILURE.message);
  assert.notEqual(second, first);
  assert.notEqual(second?.failure, first.failure);
});

test("constructor and operations have no global environment dependency", async () => {
  const priorUrl = process.env.SUPABASE_URL;
  const priorKey = process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  try {
    const isolatedStore = new SupabaseIndexingJobStore({
      client: new FakeSupabaseClient(),
    });
    assert.deepEqual(await isolatedStore.listJobs(), []);
  } finally {
    if (priorUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = priorUrl;
    if (priorKey === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = priorKey;
  }
});

test("API, worker, and status route share persistent jobs across store instances", async () => {
  const apiStore = new SupabaseIndexingJobStore({ client });
  const workerStore = new SupabaseIndexingJobStore({ client });
  const statusStore = new SupabaseIndexingJobStore({ client });
  const user = { userId: "persistent-user", email: "persistent@example.com" };
  const authorization = `Bearer ${await signAccessToken(user)}`;

  const api = createApp({ indexingJobStore: apiStore });
  const connectResponse = await api.request("/repos/connect", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({ repoUrl: "https://github.com/acme/persistent" }),
  });
  const connectBody = await connectResponse.json() as {
    success: boolean;
    data: Record<string, unknown>;
  };

  assert.equal(connectResponse.status, 200);
  assert.deepEqual(connectBody.data, {
    repositoryId: "acme/persistent",
    jobId: "indexing-job-1",
    status: "queued",
  });
  assert.equal(client.rows[0]?.status, "queued");

  const repositoryStore: IndexingJobRepositoryStore = {
    markIndexing() {},
    markIndexed() {},
    markFailed() {},
  };
  const commandResult = await runProcessNextIndexingJobCommand({
    workerId: "manual-worker",
    jobStore: workerStore,
    repositoryStore,
    executeIndexingPipeline: async () => ({
      counts: {
        chunkCount: 2,
        fileCount: 1,
        symbolCount: 1,
        graphNodeCount: 1,
        graphEdgeCount: 0,
        summaryAvailable: true,
      },
    }),
    writeOutput() {},
  });

  assert.equal(commandResult.status, "succeeded");
  assert.equal(commandResult.jobId, "indexing-job-1");

  const statusApi = createApp({ indexingJobStore: statusStore });
  const statusResponse = await statusApi.request(
    "/indexing/jobs/indexing-job-1",
    { headers: { authorization } },
  );
  const statusBody = await statusResponse.json() as {
    success: boolean;
    data: Record<string, unknown>;
  };

  assert.equal(statusResponse.status, 200);
  assert.deepEqual(statusBody.data, {
    jobId: "indexing-job-1",
    repositoryId: "acme/persistent",
    status: "succeeded",
    progress: 100,
    currentStage: "complete",
    attempt: 1,
    maxAttempts: 3,
    failure: null,
  });
});
