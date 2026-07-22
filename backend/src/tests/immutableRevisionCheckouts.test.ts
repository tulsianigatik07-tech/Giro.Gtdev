import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import test from "node:test";

import { authorizeRepository } from "../services/repository/ownershipGuard.js";
import { collectRepositoryCheckouts, sealRepositoryCheckout } from "../services/repository/revisionCheckouts.js";
import { MemoryRepositoryStore } from "../services/repository/store/memoryRepositoryStore.js";
import {
  ensureRepositoryRevisionRoot,
  repositoryCheckoutPath,
  validateRepositoryCheckout,
} from "../services/security/repositoryPaths.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const COUNTS = { chunkCount: 1, fileCount: 1, symbolCount: 1, graphNodeCount: 1, graphEdgeCount: 0, summaryAvailable: true };

test("authorization resolves only the atomically published revision", () => {
  const store = new MemoryRepositoryStore();
  const repository = store.connectRepository({ owner: "acme", repo: "published", ownerUserId: "user-1" });
  store.markIndexed(repository.repositoryId, { counts: COUNTS, indexedRevision: A });
  store.beginPublishing(repository.repositoryId, B);

  const access = authorizeRepository({ repositoryId: repository.repositoryId, userId: "user-1", store });
  assert.equal(access.ok, true);
  if (!access.ok) return;
  assert.equal(access.repository.indexedRevision, A);
  assert.equal(access.repository.checkoutPath, repositoryCheckoutPath(repository.repositoryId, A));
});

test("failed publication preserves current revision and rollback swaps published pointers", () => {
  const store = new MemoryRepositoryStore();
  const repository = store.connectRepository({ owner: "acme", repo: "rollback" });
  store.markIndexed(repository.repositoryId, { counts: COUNTS, indexedRevision: A });
  store.beginPublishing(repository.repositoryId, B);
  store.markFailed(repository.repositoryId, { reason: "persistence failed" });
  assert.equal(store.getRepository(repository.repositoryId)?.currentRevision, A);
  assert.equal(store.getRepository(repository.repositoryId)?.publishingRevision, null);

  store.markIndexed(repository.repositoryId, { counts: COUNTS, indexedRevision: B });
  assert.equal(store.getRepository(repository.repositoryId)?.previousRevision, A);
  store.rollbackRevision(repository.repositoryId);
  assert.equal(store.getRepository(repository.repositoryId)?.currentRevision, A);
  assert.equal(store.getRepository(repository.repositoryId)?.previousRevision, B);
});

test("revision checkout is sealed and concurrent GC preserves published pointers", async () => {
  const repositoryId = `immutable-${process.pid}-${Date.now()}/checkout`;
  const root = repositoryCheckoutPath(repositoryId);
  const store = new MemoryRepositoryStore();
  store.connectRepository({ owner: repositoryId.split("/")[0]!, repo: "checkout" });
  try {
    await ensureRepositoryRevisionRoot(repositoryId);
    for (const revision of [A, B, C]) {
      const checkout = repositoryCheckoutPath(repositoryId, revision);
      await mkdir(checkout, { recursive: true });
      await writeFile(`${checkout}/revision.txt`, revision, "utf8");
    }
    store.markIndexed(repositoryId, { counts: COUNTS, indexedRevision: A });
    store.markIndexed(repositoryId, { counts: COUNTS, indexedRevision: B });
    store.beginPublishing(repositoryId, C);

    const published = await validateRepositoryCheckout(repositoryId, { revision: B, mustExist: true });
    await sealRepositoryCheckout(published);
    assert.equal((await stat(published)).mode & 0o777, 0o555);
    await assert.rejects(access(`${published}/revision.txt`, constants.W_OK));

    assert.deepEqual(await Promise.all([
      collectRepositoryCheckouts(repositoryId, store, 1),
      collectRepositoryCheckouts(repositoryId, store, 1),
    ]), [0, 0]);
    store.markFailed(repositoryId);
    await utimes(repositoryCheckoutPath(repositoryId, C), new Date(0), new Date(0));
    const deleted = await Promise.all([
      collectRepositoryCheckouts(repositoryId, store, 1),
      collectRepositoryCheckouts(repositoryId, store, 1),
    ]);
    assert.ok(deleted.reduce((sum, value) => sum + value, 0) >= 1);
    assert.equal(await readFile(`${repositoryCheckoutPath(repositoryId, A)}/revision.txt`, "utf8"), A);
    assert.equal(await readFile(`${repositoryCheckoutPath(repositoryId, B)}/revision.txt`, "utf8"), B);
  } finally {
    await chmod(repositoryCheckoutPath(repositoryId, B), 0o700).catch(() => undefined);
    await chmod(`${repositoryCheckoutPath(repositoryId, B)}/revision.txt`, 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("durable publication migration fences recovery, rollback, and protected GC", async () => {
  const sql = (await readFile(new URL(
    "../../supabase/migrations/20260726000000_add_immutable_revision_publication.sql",
    import.meta.url,
  ), "utf8")).toLowerCase();
  for (const contract of [
    "current_revision", "publishing_revision", "previous_revision",
    "repository_publication_fence_conflict", "lease_expires_at > now()",
    "repository artifacts are not ready to publish", "rollback_repository_revision",
    "s.revision <> coalesce(repository_row.current_revision",
    "s.revision <> coalesce(repository_row.publishing_revision",
  ]) assert.ok(sql.includes(contract), `missing immutable revision contract: ${contract}`);
});
