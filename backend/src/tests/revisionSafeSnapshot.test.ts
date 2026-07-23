import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import test from "node:test";

import { cloneRepo, repoClonePath } from "../services/repository/clone.js";
import { MemoryRepositoryStore } from "../services/repository/store/memoryRepositoryStore.js";
import {
  SupabaseRepositorySnapshotStore,
  type RepositorySnapshotIdentity,
} from "../services/indexing/snapshots/repositorySnapshotStore.js";

const REVISION_A = "a".repeat(40);
const REVISION_B = "b".repeat(40);
const IDENTITY: RepositorySnapshotIdentity = {
  repositoryId: "acme/api",
  revision: REVISION_B,
  branch: "main",
  jobId: "indexing-job-2",
  workerId: "worker-1",
  claimToken: "snapshot-claim-token",
};

test("clone checkout resolves one detached immutable revision", async () => {
  const owner = `snapshot-${process.pid}-${Date.now()}`;
  const repo = "checkout";
  const clonePath = repoClonePath(owner, repo);
  const checkoutCalls: unknown[] = [];
  try {
    const result = await cloneRepo(owner, repo, {
      branch: "main",
      executeClone: async (_url, target) => { await mkdir(target, { recursive: true }); },
      checkoutSnapshot: async (input) => {
        checkoutCalls.push(input);
        return { commitSha: REVISION_A, branch: "main" };
      },
    });
    assert.equal(result.commitSha, REVISION_A);
    assert.equal(result.branch, "main");
    assert.equal(result.alreadyExisted, false);
    assert.equal(checkoutCalls.length, 1);
    const checkout = checkoutCalls[0] as {
      clonePath: string; branch: string | null; reusedClone: boolean; timeoutMs: number;
    };
    assert.equal(checkout.clonePath, clonePath);
    assert.equal(checkout.branch, "main");
    assert.equal(checkout.reusedClone, false);
    assert.ok(checkout.timeoutMs > 0);
  } finally {
    await rm(clonePath, { recursive: true, force: true });
  }
});

test("snapshot adapter scopes summary, publication, and rollback to one revision", async () => {
  const calls: Array<{ kind: string; name: string; values: Record<string, unknown> }> = [];
  const client = {
    from: (name: string) => ({
      upsert: async (values: Record<string, unknown>) => {
        calls.push({ kind: "upsert", name, values });
        return { error: null };
      },
    }),
    rpc: async (name: string, values: Record<string, unknown>) => {
      calls.push({ kind: "rpc", name, values });
      return {
        data: name === "begin_repository_snapshot"
          ? [{ already_published: false, chunk_count: 0, file_count: 0 }]
          : null,
        error: null,
      };
    },
  };
  const store = new SupabaseRepositorySnapshotStore(client);
  assert.deepEqual(await store.begin(IDENTITY), { alreadyPublished: false, counts: null });
  await store.saveSummary(IDENTITY, {
    repositoryId: IDENTITY.repositoryId,
    repositoryVersion: IDENTITY.revision,
    generatedAt: "2026-07-19T00:00:00.000Z",
  } as never);
  await store.publish({
    ...IDENTITY,
    embeddingVersion: "embedding-index-test",
    counts: { chunkCount: 2, fileCount: 1, symbolCount: 3, graphNodeCount: 3, graphEdgeCount: 1, summaryAvailable: true },
    indexOptions: { indexMode: "full", changedFileCount: 1, indexedRevision: REVISION_B },
  });
  await store.discard(IDENTITY);

  assert.deepEqual(calls.map((call) => call.name), [
    "begin_repository_snapshot",
    "save_repository_snapshot_summary",
    "publish_repository_snapshot",
    "discard_repository_snapshot",
  ]);
  assert.equal(calls[1]?.values.input_revision, REVISION_B);
  assert.equal(calls[2]?.values.input_revision, REVISION_B);
  assert.equal(calls[3]?.values.input_revision, REVISION_B);
});

test("failed reindex preserves the previous published repository state", () => {
  const store = new MemoryRepositoryStore();
  const connected = store.connectRepository({ owner: "acme", repo: "api" });
  store.markIndexed(connected.repositoryId, {
    counts: { chunkCount: 4, fileCount: 2, symbolCount: 3, graphNodeCount: 2, graphEdgeCount: 1, summaryAvailable: true },
    indexedRevision: REVISION_A,
  });
  store.markIndexing(connected.repositoryId);
  store.markFailed(connected.repositoryId, { reason: "new revision failed" });
  const current = store.getRepository(connected.repositoryId);
  assert.equal(current?.status, "indexed");
  assert.equal(current?.indexedRevision, REVISION_A);
  assert.equal(current?.chunkCount, 4);
});

test("migration makes publication, cleanup, and job completion one transaction", async () => {
  const sql = (await readFile(new URL(
    "../../supabase/migrations/20260716000000_create_revision_safe_snapshots.sql",
    import.meta.url,
  ), "utf8")).toLowerCase();
  for (const contract of [
    "begin_repository_snapshot",
    "publish_repository_snapshot",
    "discard_repository_snapshot",
    "for update",
    "indexed_revision = input_revision",
    "repository_revision <> input_revision",
    "summary_kind = 'architecture'",
    "status = 'succeeded'",
    "progress = 100",
    "current_stage = 'complete'",
  ]) assert.ok(sql.includes(contract), `missing snapshot contract: ${contract}`);
  assert.match(sql, /revision ~ '\^\[0-9a-f\]\{40\}\$'/);
  assert.match(sql, /chunks\.repository_revision = input_repository_revision/);
  assert.match(sql, /repositories\.indexed_revision = input_repository_revision/);
  assert.doesNotMatch(sql, /or input_repository_revision is null/);
  assert.doesNotMatch(sql, /input_repository_revision text default null/);
});
