import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MemoryEmbeddingIndexStore,
  SupabaseEmbeddingIndexStore,
} from "../services/embeddings/indexStore.js";
import {
  createEmbeddingVersion,
  type EmbeddingIndexConfiguration,
} from "../services/embeddings/indexVersion.js";
import type { RepositorySnapshotIdentity } from "../services/indexing/snapshots/repositorySnapshotStore.js";

const REPOSITORY = "acme/api";
const REVISION_A = "a".repeat(40);
const REVISION_B = "b".repeat(40);
const IDENTITY_A: RepositorySnapshotIdentity = {
  repositoryId: REPOSITORY,
  revision: REVISION_A,
  branch: "main",
  jobId: "indexing-job-a",
  workerId: "worker-1",
  claimToken: "claim-a",
};

function configuration(
  revision = REVISION_A,
  overrides: Partial<Omit<EmbeddingIndexConfiguration, "embeddingVersion">> = {},
): EmbeddingIndexConfiguration {
  const input = {
    repositoryId: REPOSITORY,
    repositoryRevision: revision,
    embeddingProvider: "mock" as const,
    embeddingModel: "text-embedding-3-small",
    embeddingDimension: 1536,
    chunkingStrategyVersion: "line-window-120-overlap-20-v1",
    ...overrides,
  };
  return { ...input, embeddingVersion: createEmbeddingVersion(input) };
}

function chunk(
  config: EmbeddingIndexConfiguration,
  chunkId: string,
  chunkHash = `hash-${chunkId}`,
  dimension = config.embeddingDimension,
) {
  return {
    repository: config.repositoryId,
    repositoryRevision: config.repositoryRevision,
    embeddingVersion: config.embeddingVersion,
    filePath: `src/${chunkId}.ts`,
    language: "typescript",
    chunkIndex: 0,
    chunkId,
    chunkHash,
    content: `export const ${chunkId.replace(/\W/g, "_")} = true;`,
    summary: null,
    startLine: 1,
    endLine: 1,
    embedding: Array.from({ length: dimension }, () => 0),
    tokenCount: 4,
  };
}

async function publish(
  store: MemoryEmbeddingIndexStore,
  identity: RepositorySnapshotIdentity,
  config: EmbeddingIndexConfiguration,
  ids: string[],
): Promise<void> {
  await store.begin(identity, config);
  for (const id of ids) await store.storeChunk(chunk(config, id));
  await store.validate(identity, config.embeddingVersion, ids.length);
  store.publish(config.repositoryId, config.repositoryRevision, config.embeddingVersion);
}

test("successful publication exposes one complete validated immutable embedding index", async () => {
  const store = new MemoryEmbeddingIndexStore();
  const config = configuration();
  await publish(store, IDENTITY_A, config, ["one", "two"]);
  assert.deepEqual(store.current(REPOSITORY, REVISION_A).map((item) => item.chunkId), ["one", "two"]);
  await assert.rejects(() => store.storeChunk(chunk(config, "three")), /not mutable/i);
  await store.verify();
});

test("failed publication and rollback preserve the previous published index", async () => {
  const store = new MemoryEmbeddingIndexStore();
  const previous = configuration(REVISION_A);
  await publish(store, IDENTITY_A, previous, ["stable"]);

  const identityB = { ...IDENTITY_A, revision: REVISION_B, jobId: "indexing-job-b", claimToken: "claim-b" };
  const replacement = configuration(REVISION_B);
  await store.begin(identityB, replacement);
  await store.storeChunk(chunk(replacement, "partial"));
  await assert.rejects(
    () => store.validate(identityB, replacement.embeddingVersion, 2),
    /validation failed/i,
  );
  await store.discard(identityB, replacement.embeddingVersion);

  assert.deepEqual(store.current(REPOSITORY, REVISION_A).map((item) => item.chunkId), ["stable"]);
  assert.deepEqual(store.current(REPOSITORY, REVISION_B), []);
});

test("retrieval never exposes building, failed, superseded, or wrong-revision vectors", async () => {
  const store = new MemoryEmbeddingIndexStore();
  const first = configuration(REVISION_A);
  await publish(store, IDENTITY_A, first, ["old"]);
  const identityB = { ...IDENTITY_A, revision: REVISION_B, jobId: "indexing-job-b", claimToken: "claim-b" };
  const second = configuration(REVISION_B);
  await store.begin(identityB, second);
  await store.storeChunk(chunk(second, "new"));
  assert.deepEqual(store.current(REPOSITORY, REVISION_B), []);
  assert.deepEqual(store.current(REPOSITORY, REVISION_A).map((item) => item.chunkId), ["old"]);
  await store.validate(identityB, second.embeddingVersion, 1);
  assert.deepEqual(store.current(REPOSITORY, REVISION_B), []);
  store.publish(REPOSITORY, REVISION_B, second.embeddingVersion);
  assert.deepEqual(store.current(REPOSITORY, REVISION_A), []);
  assert.deepEqual(store.current(REPOSITORY, REVISION_B).map((item) => item.chunkId), ["new"]);
});

test("model, provider, dimension, and chunking changes deterministically require new versions", () => {
  const baseline = configuration();
  const variants = [
    configuration(REVISION_A, { embeddingModel: "text-embedding-4" }),
    configuration(REVISION_A, { embeddingProvider: "openai" }),
    configuration(REVISION_A, { embeddingDimension: 3072 }),
    configuration(REVISION_A, { chunkingStrategyVersion: "ast-v2" }),
  ];
  assert.equal(new Set([baseline.embeddingVersion, ...variants.map((item) => item.embeddingVersion)]).size, 5);
  assert.equal(configuration().embeddingVersion, baseline.embeddingVersion);
});

test("dimension mismatch and duplicate chunk hashes fail validation", async () => {
  const dimensionStore = new MemoryEmbeddingIndexStore();
  const config = configuration();
  await dimensionStore.begin(IDENTITY_A, config);
  await assert.rejects(
    () => dimensionStore.storeChunk(chunk(config, "wrong", "wrong-hash", 2)),
    /dimension mismatch/i,
  );

  const duplicateStore = new MemoryEmbeddingIndexStore();
  await duplicateStore.begin(IDENTITY_A, config);
  await duplicateStore.storeChunk(chunk(config, "one", "duplicate"));
  await duplicateStore.storeChunk(chunk(config, "two", "duplicate"));
  await assert.rejects(
    () => duplicateStore.validate(IDENTITY_A, config.embeddingVersion, 2),
    /validation failed/i,
  );
  assert.deepEqual(duplicateStore.current(REPOSITORY, REVISION_A), []);
});

test("restart recovery removes abandoned temporary vectors without affecting publication", async () => {
  const store = new MemoryEmbeddingIndexStore();
  const published = configuration(REVISION_A);
  await publish(store, IDENTITY_A, published, ["stable"]);
  const identityB = { ...IDENTITY_A, revision: REVISION_B, jobId: "indexing-job-b", claimToken: "claim-b" };
  const abandoned = configuration(REVISION_B);
  await store.begin(identityB, abandoned);
  await store.storeChunk(chunk(abandoned, "orphan"));
  assert.equal(await store.recover(), 1);
  assert.deepEqual(store.current(REPOSITORY, REVISION_A).map((item) => item.chunkId), ["stable"]);
  assert.deepEqual(store.current(REPOSITORY, REVISION_B), []);
});

test("concurrent publication of the same deterministic version is fenced", async () => {
  const store = new MemoryEmbeddingIndexStore();
  const config = configuration();
  await store.begin(IDENTITY_A, config);
  const competitor = { ...IDENTITY_A, jobId: "indexing-job-other", claimToken: "other-claim" };
  await assert.rejects(() => store.begin(competitor, config), /already being built/i);
});

test("memory and Supabase adapters expose equivalent lifecycle results", async () => {
  const config = configuration();
  const memory = new MemoryEmbeddingIndexStore();
  assert.deepEqual(await memory.begin(IDENTITY_A, config), {
    alreadyPublished: false,
    configuration: config,
  });

  const calls: string[] = [];
  const client = {
    rpc(name: string) {
      calls.push(name);
      const data = name === "begin_embedding_index_version"
        ? [{ already_published: false }]
        : name === "validate_embedding_index_version"
          ? [{
              expected_vector_count: 0,
              vector_count: 0,
              orphan_vector_count: 0,
              duplicate_chunk_hash_count: 0,
              missing_metadata_count: 0,
              dimension_mismatch_count: 0,
              is_valid: true,
            }]
          : name === "recover_embedding_index_versions"
            ? [{ cleaned_version_count: 0 }]
            : name === "verify_embedding_index_contract"
              ? [{ valid: true }]
              : null;
      return Promise.resolve({ data, error: null });
    },
  };
  const database = new SupabaseEmbeddingIndexStore(client as never);
  assert.deepEqual(await database.begin(IDENTITY_A, config), {
    alreadyPublished: false,
    configuration: config,
  });
  assert.equal((await database.validate(IDENTITY_A, config.embeddingVersion, 0)).valid, true);
  assert.equal(await database.recover(), 0);
  await database.verify();
  assert.deepEqual(calls, [
    "begin_embedding_index_version",
    "validate_embedding_index_version",
    "recover_embedding_index_versions",
    "verify_embedding_index_contract",
  ]);
});

test("migration and startup contract enforce atomic publication, retrieval gating, and cleanup", async () => {
  const sql = (await readFile(new URL(
    "../../supabase/migrations/20260803000000_add_embedding_index_versions.sql",
    import.meta.url,
  ), "utf8")).toLowerCase();
  for (const field of [
    "repository_id", "repository_revision", "embedding_provider", "embedding_model",
    "embedding_dimension", "embedding_version", "chunking_strategy_version",
    "created_at", "published_at", "status",
  ]) assert.match(sql, new RegExp(`\\b${field}\\b`), field);
  for (const status of ["building", "validating", "published", "failed", "superseded"]) {
    assert.match(sql, new RegExp(`'${status}'`), status);
  }
  for (const contract of [
    "embedding_index_publications",
    "embedding_index_validations",
    "repository_chunks_embedding_version_identity_fkey",
    "repository_chunks_immutable_version_trigger",
    "validate_embedding_index_version",
    "discard_embedding_index_version",
    "recover_embedding_index_versions",
    "verify_embedding_index_contract",
    "published_repository_chunks",
    "vector_dims",
    "duplicate_chunk_hash_count",
    "missing_metadata_count",
    "dimension_mismatch_count",
    "input_embedding_version",
    "indexing_job_lease_conflict",
    "for update",
  ]) assert.ok(sql.includes(contract), `missing embedding contract: ${contract}`);
  assert.match(sql, /join public\.embedding_index_validations[\s\S]+validations\.is_valid/);
  assert.match(sql, /join public\.repositories[\s\S]+repositories\.current_revision = publications\.repository_revision/);
  assert.match(sql, /perform public\.publish_repository_snapshot[\s\S]+insert into public\.embedding_index_publications/);
  assert.match(sql, /revoke execute on function public\.publish_repository_snapshot[\s\S]+from service_role/);

  const startup = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(startup, /runtimeEmbeddingIndexStore\.verify\(\)/);
  assert.match(startup, /runtimeEmbeddingIndexStore\.recover\(\)/);
  assert.ok(
    startup.indexOf("runtimeEmbeddingIndexStore.verify()") <
      startup.indexOf("server = serve("),
    "startup validation must complete before the server accepts traffic",
  );
});
