import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryIndexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import { normalizeIndexingJobFailure, processNextIndexingJob } from "../services/indexing/jobs/indexingJobWorker.js";
import { MemoryRepositoryArtifactStore } from "../services/repository/artifacts/repositoryArtifactStore.js";
import {
  RepositoryQuotaError,
  serializedArtifactBytes,
  type RepositoryQuotas,
} from "../services/repository/quotas/repositoryQuota.js";
import { scanRepositoryQuota } from "../services/repository/quotas/repositoryQuotaScanner.js";
import {
  MemoryRepositoryQuotaStore,
  SupabaseRepositoryQuotaStore,
} from "../services/repository/quotas/repositoryQuotaStore.js";
import { MemoryRepositoryStore } from "../services/repository/store/memoryRepositoryStore.js";
import {
  recoverAbandonedRepositoryCheckouts,
  removeUnpublishedRepositoryCheckout,
} from "../services/repository/revisionCheckouts.js";
import {
  ensureRepositoryRevisionRoot,
  repositoryCheckoutPath,
  type TrustedRepositoryCheckoutPath,
} from "../services/security/repositoryPaths.js";

const BASE: RepositoryQuotas = {
  maxRepositoryBytes: 1_000_000,
  maxFiles: 100,
  maxDirectoryDepth: 10,
  maxFileBytes: 100_000,
  maxSymlinks: 10,
  maxBinaryFiles: 10,
  maxIndexedTextBytes: 500_000,
  maxArtifactBytes: 100_000,
  maxIndexingDurationMs: 1_000,
  maxConcurrentIndexingPerUser: 2,
  maxIndexedRepositoriesPerUser: 10,
  maxStorageBytesPerUser: 10_000_000,
};

async function fixture(files: Record<string, string | Buffer>): Promise<TrustedRepositoryCheckoutPath> {
  const root = await mkdtemp(path.join(os.tmpdir(), "giro-quota-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return await realpath(root) as TrustedRepositoryCheckoutPath;
}

async function quotaFailure(
  files: Record<string, string | Buffer>,
  quotas: RepositoryQuotas,
): Promise<RepositoryQuotaError> {
  const root = await fixture(files);
  try {
    await assert.rejects(scanRepositoryQuota(root, quotas), (error: unknown) => {
      assert.ok(error instanceof RepositoryQuotaError);
      return true;
    });
    try {
      await scanRepositoryQuota(root, quotas);
    } catch (error) {
      return error as RepositoryQuotaError;
    }
    throw new Error("quota scan unexpectedly succeeded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("oversized repositories fail with deterministic structured usage", async () => {
  const error = await quotaFailure({ "a.ts": "a".repeat(20), "b.ts": "b".repeat(20) }, {
    ...BASE, maxRepositoryBytes: 30,
  });
  assert.equal(error.reason, "repository_size");
  assert.equal(error.limit, 30);
  assert.equal(error.observed, 40);
});

test("excessive files and directory depth abort scanning", async () => {
  assert.equal((await quotaFailure({ "a.ts": "a", "b.ts": "b" }, {
    ...BASE, maxFiles: 1,
  })).reason, "file_count");
  assert.equal((await quotaFailure({ "a/b/c/file.ts": "x" }, {
    ...BASE, maxDirectoryDepth: 2,
  })).reason, "directory_depth");
});

test("huge and excessive binary files are rejected", async () => {
  assert.equal((await quotaFailure({ "large.bin": Buffer.alloc(20, 0) }, {
    ...BASE, maxFileBytes: 10,
  })).reason, "file_size");
  assert.equal((await quotaFailure({ "a.bin": Buffer.from([0, 1]), "b.bin": Buffer.from([0, 2]) }, {
    ...BASE, maxBinaryFiles: 1,
  })).reason, "binary_file_count");
});

test("symlink and indexed text budgets are enforced without following links", async () => {
  const root = await fixture({ "a.ts": "hello" });
  try {
    await symlink("a.ts", path.join(root, "link.ts"));
    await assert.rejects(scanRepositoryQuota(root, { ...BASE, maxSymlinks: 0 }),
      (error: unknown) => error instanceof RepositoryQuotaError && error.reason === "symlink_count");
    await assert.rejects(scanRepositoryQuota(root, { ...BASE, maxIndexedTextBytes: 4 }),
      (error: unknown) => error instanceof RepositoryQuotaError && error.reason === "indexed_text_bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact staging rejects serialized payloads over budget", async () => {
  const store = new MemoryRepositoryArtifactStore();
  const identity = {
    repositoryId: "acme/demo", revision: "a".repeat(40), branch: null,
    jobId: "job-1", workerId: "worker-1", claimToken: "claim-1",
  };
  store.begin(identity);
  const artifacts = {
    graph: { repositoryId: "acme/demo", repositoryVersion: "a".repeat(40), nodes: [], edges: [] },
    summary: { repositoryId: "acme/demo", repositoryVersion: "a".repeat(40) },
    fileSnapshot: { updatedAt: "now", files: [] }, symbolIndex: [], graphSource: [],
  } as never;
  const bytes = serializedArtifactBytes(artifacts);
  await assert.rejects(store.stage(identity, artifacts, bytes - 1),
    (error: unknown) => error instanceof RepositoryQuotaError && error.reason === "artifact_size");
});

test("per-user concurrent indexing quota is deterministic and idempotent", async () => {
  const store = new MemoryIndexingJobStore({ maxConcurrentPerUser: 1 });
  const input = {
    repositoryId: "acme/one", ownerUserId: "user-1", repositoryOwner: "acme",
    repositoryName: "one", repositoryUrl: "https://github.com/acme/one",
  };
  const first = await store.createJob(input);
  assert.equal((await store.createJob(input)).jobId, first.jobId);
  await assert.rejects(store.createJob({ ...input, repositoryId: "acme/two", repositoryName: "two" }),
    (error: unknown) => error instanceof RepositoryQuotaError && error.reason === "concurrent_indexing");
});

test("quota failures normalize to non-retryable structured job failures", () => {
  const failure = normalizeIndexingJobFailure(
    new RepositoryQuotaError("indexing_duration", 10, 11),
    { repositoryId: "acme/demo", stage: "finalize" },
  );
  assert.deepEqual(failure, {
    code: "repository_quota_exceeded",
    message: "Repository quota exceeded: indexing_duration.",
    retryable: false,
    details: { reason: "indexing_duration", limit: 10, observed: 11 },
  });
});

test("maximum indexing duration aborts and terminally fails the fenced job", async () => {
  const jobs = new MemoryIndexingJobStore();
  const repositories = new MemoryRepositoryStore();
  repositories.connectRepository({ owner: "acme", repo: "timeout", ownerUserId: "user-1" });
  await jobs.createJob({
    repositoryId: "acme/timeout", ownerUserId: "user-1", repositoryOwner: "acme",
    repositoryName: "timeout", repositoryUrl: "https://github.com/acme/timeout",
  });
  const report = await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: jobs,
    repositoryAuthorizationStore: repositories,
    repositoryStore: { markIndexing: () => undefined, markIndexed: () => undefined, markFailed: () => undefined },
    quotas: { ...BASE, maxIndexingDurationMs: 5 },
    executeIndexingPipeline: ({ signal }) => new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failure?.code, "repository_quota_exceeded");
  assert.equal(report.failure?.details?.reason, "indexing_duration");
});

test("quota cleanup removes abandoned revisions and preserves the published rollback pair", async () => {
  const repositories = new MemoryRepositoryStore();
  let repository = repositories.connectRepository({ owner: "quota-test", repo: "cleanup", ownerUserId: "user-1" });
  const current = "a".repeat(40);
  const previous = "b".repeat(40);
  const abandoned = "c".repeat(40);
  repository = repositories.updateRepository(repository.repositoryId, {
    currentRevision: current, previousRevision: previous, indexedRevision: current,
  }, repository.persistenceVersion ?? 1)!;
  await ensureRepositoryRevisionRoot(repository.repositoryId);
  for (const revision of [current, previous, abandoned]) {
    await mkdir(repositoryCheckoutPath(repository.repositoryId, revision), { recursive: true });
  }
  assert.equal(await removeUnpublishedRepositoryCheckout(repository.repositoryId, current, repositories), false);
  assert.equal(await removeUnpublishedRepositoryCheckout(repository.repositoryId, previous, repositories), false);
  assert.equal(await removeUnpublishedRepositoryCheckout(repository.repositoryId, abandoned, repositories), true);
  await rm(repositoryCheckoutPath(repository.repositoryId), { recursive: true, force: true });
});

test("startup recovery clears an abandoned publication fence before checkout cleanup", async () => {
  const repositories = new MemoryRepositoryStore();
  const jobs = new MemoryIndexingJobStore({ maxConcurrentPerUser: 2 });
  const repository = repositories.connectRepository({
    owner: "quota-test",
    repo: "startup-cleanup",
    ownerUserId: "user-1",
  });
  const revision = "d".repeat(40);
  await repositories.beginPublishing?.(repository.repositoryId, revision);
  await ensureRepositoryRevisionRoot(repository.repositoryId);
  const checkout = repositoryCheckoutPath(repository.repositoryId, revision);
  await mkdir(checkout, { recursive: true });

  assert.equal(
    await recoverAbandonedRepositoryCheckouts(repository.repositoryId, repositories, jobs, 0),
    1,
  );
  assert.equal((await repositories.getRepository(repository.repositoryId))?.publishingRevision, null);
  await assert.rejects(stat(checkout));
  await rm(repositoryCheckoutPath(repository.repositoryId), { recursive: true, force: true });
});

test("memory and Supabase usage stores expose equivalent per-user tracking", async () => {
  const memory = new MemoryRepositoryQuotaStore();
  memory.recordRepository("acme/one", "user-1", 40);
  memory.recordRepository("acme/two", "user-1", 60);
  memory.recordActiveJob("job-1", "user-1");
  const expected = await memory.getUserUsage("user-1");
  const supabase = new SupabaseRepositoryQuotaStore({
    rpc: async () => ({
      data: [{ indexed_repositories: 2, storage_bytes: 100, concurrent_jobs: 1 }], error: null,
    }),
  });
  assert.deepEqual(await supabase.getUserUsage("user-1"), expected);
});

test("migration atomically enforces concurrent, artifact, publication, and tracking quotas", async () => {
  const sql = (await readFile(new URL(
    "../../supabase/migrations/20260729000000_add_repository_resource_quotas.sql",
    import.meta.url,
  ), "utf8")).toLowerCase();
  for (const contract of [
    "repository_quota_usage", "pg_advisory_xact_lock", "concurrent_indexing",
    "input_max_artifact_bytes", "artifact_size", "input_max_indexed_repositories",
    "input_max_user_storage_bytes", "indexed_repositories", "user_storage",
    "get_user_repository_quota_usage", "on delete cascade", "service_role",
  ]) assert.ok(sql.includes(contract), `missing quota migration contract: ${contract}`);
});
