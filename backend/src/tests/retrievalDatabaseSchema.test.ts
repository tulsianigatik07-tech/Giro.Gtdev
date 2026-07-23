import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { semanticSearch } from "../services/embeddings/search.js";
import { deleteRepositoryRetrievalData, storeChunkEmbedding } from "../services/embeddings/store.js";
import { keywordSearch } from "../services/retrieval/keywordSearch.js";
import { loadSummary, saveSummary } from "../services/intelligence/summaryStore.js";
import { runtimeEmbeddingIndexConfiguration } from "../services/embeddings/indexVersion.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(testDirectory, "../../supabase/migrations");
const migrationName = "20260714000000_create_retrieval_schema.sql";
const sql = readFileSync(path.join(migrationsDirectory, migrationName), "utf8");
const revisionSafeMigrationName = "20260716000000_create_revision_safe_snapshots.sql";
const revisionSafeSql = readFileSync(path.join(migrationsDirectory, revisionSafeMigrationName), "utf8");
const matchFunctionMigrations = [
  [migrationName, sql],
  [revisionSafeMigrationName, revisionSafeSql],
] as const;

test("retrieval migration remains versioned before later milestones", () => {
  const migrations = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(migrations.includes(migrationName));
  assert.ok(migrations.indexOf(migrationName) < migrations.indexOf("20260715000000_create_supervised_indexing_worker.sql"));
});

test("fresh schema provisions only the extensions used by retrieval", () => {
  assert.match(sql, /create extension if not exists vector with schema extensions/i);
  assert.match(sql, /create extension if not exists pg_trgm with schema extensions/i);
  assert.doesNotMatch(sql, /uuid-ossp/i);
});

test("repository chunks match the runtime row contract and 1536-dimension embeddings", () => {
  for (const field of [
    "id text primary key", "repository text not null", "repository_revision text not null",
    "file_path text not null", "language text not null", "chunk_index integer not null",
    "content text not null", "summary text", "start_line integer not null",
    "end_line integer not null", "content_hash text not null", "token_count integer not null",
    "character_count integer not null", "embedding %i.vector(1536) not null",
    "metadata jsonb not null", "created_at timestamptz", "updated_at timestamptz",
  ]) assert.ok(sql.toLowerCase().includes(field), `missing chunk field: ${field}`);
});

test("chunk uniqueness and indexes align with snapshot, keyword, semantic, and cleanup queries", () => {
  assert.match(sql, /pg_catalog\.pg_extension/);
  assert.match(sql, /pg_catalog\.pg_opclass/);

  assert.match(
    sql,
    /unique index[^;]+\(repository, repository_revision, file_path, chunk_index\)/is,
  );

  assert.match(
    sql,
    /unique index[^;]+\(repository, repository_revision, file_path, content_hash, start_line, end_line\)/is,
  );

  assert.match(sql, /using gin \(content %I\.gin_trgm_ops\)/i);
  assert.match(sql, /using gin \(file_path %I\.gin_trgm_ops\)/i);
  assert.match(sql, /using hnsw \(embedding %I\.vector_cosine_ops\)/i);
  assert.doesNotMatch(sql, /extensions\.vector\(1536\)/i);
  assert.doesNotMatch(sql, /extensions\.vector_cosine_ops/i);
  assert.doesNotMatch(sql, /extensions\.gin_trgm_ops/i);
  assert.match(sql, /\(repository, repository_revision\)/i);
});

test("repository summaries are repository, revision, and kind scoped", () => {
  assert.match(sql, /create table if not exists public\.repository_summaries/i);
  assert.match(sql, /primary key \(repository, repository_revision, summary_kind\)/i);
  assert.match(sql, /summary jsonb not null/i);
  assert.match(sql, /summary_kind in \('intelligence', 'architecture'\)/i);
});

test("semantic RPC filters repository and active revision before bounded vector ranking", () => {
  const functionSql = sql.slice(sql.indexOf("create function public.match_repository_chunks"), sql.indexOf("create or replace function public.delete_repository_retrieval_data"));
  assert.match(functionSql, /input_repository text/i);
  assert.match(functionSql, /query_embedding %I\.vector\(1536\)/i);
  assert.match(functionSql, /match_count < 1 or match_count > 50/i);
  assert.match(functionSql, /where chunks\.repository = input_repository/i);
  assert.match(functionSql, /chunks\.repository_revision = input_repository_revision/i);
  assert.ok(functionSql.indexOf("where chunks.repository") < functionSql.indexOf("order by"));
  assert.match(functionSql, /file_path asc[\s\S]+start_line asc[\s\S]+chunk_index asc[\s\S]+id asc/i);
});

test("both match migrations remove legacy defaulted three- and four-argument overloads through catalogs", () => {
  for (const [name, migrationSql] of matchFunctionMigrations) {
    assert.match(migrationSql, /from pg_catalog\.pg_proc proc/i, name);
    assert.match(migrationSql, /join pg_catalog\.pg_namespace namespace/i, name);
    assert.match(migrationSql, /namespace\.nspname = 'public'/i, name);
    assert.match(migrationSql, /proc\.proname = 'match_repository_chunks'/i, name);
    assert.match(migrationSql, /proc\.pronargs in \(3, 4\)/i, name);
    assert.doesNotMatch(migrationSql, /proargdefaults/i, `${name} must remove matching signatures regardless of whether match_count or input_repository_revision has DEFAULT`);
    assert.match(migrationSql, /pg_catalog\.pg_get_function_identity_arguments\(proc\.oid\)/i, name);
    assert.match(migrationSql, /'drop function %I\.%I\(%s\)'/i, name);
    assert.ok(
      migrationSql.indexOf("'drop function %I.%I(%s)'") < migrationSql.indexOf("create function public.match_repository_chunks"),
      `${name} must drop legacy overloads before creating the canonical function`,
    );
  }
});

test("catalog removal is limited to known public match_repository_chunks signatures", () => {
  for (const [name, migrationSql] of matchFunctionMigrations) {
    assert.match(migrationSql, /proc\.prokind = 'f'/i, name);
    assert.match(migrationSql, /proc\.proargtypes\[0\] = 'pg_catalog\.text'::pg_catalog\.regtype/i, name);
    assert.match(migrationSql, /proc\.proargtypes\[1\] = vector_type_oid/i, name);
    assert.match(migrationSql, /proc\.proargtypes\[2\] = 'pg_catalog\.int4'::pg_catalog\.regtype/i, name);
    assert.match(migrationSql, /proc\.pronargs = 3[\s\S]+proc\.proargtypes\[3\] = 'pg_catalog\.text'::pg_catalog\.regtype/i, name);
    assert.doesNotMatch(migrationSql, /drop function[\s\S]+cascade/i, `${name} must not cascade into unrelated objects`);
  }
});

test("both migrations recreate one canonical four-input RPC without defaults or CREATE OR REPLACE", () => {
  for (const [name, migrationSql] of matchFunctionMigrations) {
    const declaration = migrationSql.match(
      /create function public\.match_repository_chunks\(([\s\S]*?)\)\s*returns table/i,
    )?.[1];
    assert.ok(declaration, `missing canonical declaration in ${name}`);
    assert.match(declaration, /input_repository text[\s\S]+query_embedding %I\.vector\(1536\)[\s\S]+match_count integer[\s\S]+input_repository_revision text/i, name);
    assert.doesNotMatch(declaration, /default/i, `${name} canonical inputs must not have defaults`);
    assert.doesNotMatch(migrationSql, /create or replace function public\.match_repository_chunks/i, name);
  }
});

test("match compatibility discovers the vector type dynamically and restores canonical privileges", () => {
  for (const [name, migrationSql] of matchFunctionMigrations) {
    assert.match(migrationSql, /from pg_catalog\.pg_extension extension/i, name);
    assert.match(migrationSql, /join pg_catalog\.pg_depend dependency/i, name);
    assert.match(migrationSql, /join pg_catalog\.pg_type vector_type/i, name);
    assert.match(migrationSql, /vector_type\.typname = 'vector'/i, name);
    assert.doesNotMatch(migrationSql, /query_embedding (?:public|extensions)\.vector/i, name);
    assert.match(migrationSql, /revoke all on function public\.match_repository_chunks\(text, %I\.vector\(1536\), integer, text\) from public, anon, authenticated/i, name);
    assert.match(migrationSql, /grant execute on function public\.match_repository_chunks\(text, %I\.vector\(1536\), integer, text\) to service_role/i, name);
  }
});

test("cleanup and permissions are repository scoped and deny direct client access", () => {
  assert.match(sql, /delete from public\.repository_chunks[\s\S]+where repository = input_repository/i);
  assert.match(sql, /delete from public\.repository_summaries[\s\S]+where repository = input_repository/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on table public\.repository_chunks from anon, authenticated/i);
  assert.match(sql, /grant all on table public\.repository_chunks to service_role/i);
  assert.match(sql, /revoke all on function public\.match_repository_chunks[^;]+from public, anon, authenticated/i);
});

test("semantic adapter sends the repository and revision in the authoritative RPC", async () => {
  let parameters: Record<string, unknown> | undefined;
  const databaseClient = {
    rpc(_name: string, input: Record<string, unknown>) {
      parameters = input;
      return {
        abortSignal: async () => ({
          data: [{ id: "chunk-1", repository: "acme/api", file_path: "src/api.ts", language: "typescript", content: "route", similarity: 0.9, start_line: 1, end_line: 2 }],
          error: null,
        }),
      };
    },
  };
  const results = await semanticSearch("routes", "acme/api", 5, {
    repositoryVersion: "job-1:1",
    generateQueryEmbedding: async () => Array.from({ length: 1536 }, () => 0),
    databaseClient: databaseClient as never,
  });
  assert.deepEqual(parameters, {
    input_repository: "acme/api",
    query_embedding: Array.from({ length: 1536 }, () => 0),
    match_count: 5,
    input_repository_revision: "job-1:1",
    input_embedding_version: runtimeEmbeddingIndexConfiguration("acme/api", "job-1:1").embeddingVersion,
  });
  assert.deepEqual(results.map((result) => result.repository), ["acme/api"]);
});

test("chunk adapter persists deterministic snapshot fields and cleanup uses one RPC", async () => {
  let persisted: Record<string, unknown> | undefined;
  let cleanup: Record<string, unknown> | undefined;
  const query = {
    upsert(value: Record<string, unknown>) {
      persisted = value;
      return { abortSignal: async () => ({ error: null }) };
    },
  };
  const databaseClient = {
    from(table: string) { assert.equal(table, "repository_chunks"); return query; },
    async rpc(name: string, input: Record<string, unknown>) {
      assert.equal(name, "delete_repository_retrieval_data"); cleanup = input;
      return { error: null };
    },
  };
  const input = {
    repository: "acme/api", repositoryRevision: "job-1:1", filePath: "src/api.ts",
    language: "typescript", chunkIndex: 0, content: "export const route = true;",
    summary: null, startLine: 1, endLine: 1, embedding: Array.from({ length: 1536 }, () => 0), tokenCount: 7,
    embeddingVersion: "embedding-index-test", chunkId: "src/api.ts:1-1", chunkHash: "chunk-hash",
  };
  await storeChunkEmbedding(input, { databaseClient: databaseClient as never });
  const firstId = persisted?.id;
  await storeChunkEmbedding(input, { databaseClient: databaseClient as never });
  assert.equal(persisted?.id, firstId);
  assert.equal(persisted?.repository_revision, "job-1:1");
  assert.equal(persisted?.token_count, 7);
  assert.equal(typeof persisted?.content_hash, "string");
  await deleteRepositoryRetrievalData("acme/api", "job-1:1", databaseClient as never);
  assert.deepEqual(cleanup, { input_repository: "acme/api", input_keep_revision: "job-1:1" });
});

test("keyword adapter scopes candidates by repository and revision before local scoring", async () => {
  const filters: Array<[string, unknown]> = [];
  const query = {
    select() { return this; },
    eq(column: string, value: unknown) { filters.push([column, value]); return this; },
    or() { return this; },
    limit() { return this; },
    async abortSignal() {
      return {
        data: [{ id: "chunk-1", repository: "acme/api", file_path: "src/auth.ts", language: "typescript", content: "authentication middleware", start_line: 1, end_line: 2 }],
        error: null,
      };
    },
  };
  const results = await keywordSearch("authentication", "acme", "api", 10, {
    repositoryVersion: "job-1:1",
    databaseClient: { from: () => query } as never,
  });
  assert.deepEqual(filters, [
    ["repository", "acme/api"],
    ["repository_revision", "job-1:1"],
    ["embedding_version", runtimeEmbeddingIndexConfiguration("acme/api", "job-1:1").embeddingVersion],
  ]);
  assert.deepEqual(results.map((result) => result.repository), ["acme/api"]);
});

test("summary adapter writes and reads repository revision scoped JSON", async () => {
  let stored: Record<string, unknown> | undefined;
  const filters: Array<[string, unknown]> = [];
  const summary = {
    repository: "acme/api",
    frameworks: ["hono"],
    architectureType: "backend-api",
    primaryLanguage: "typescript",
  };
  const query = {
    async upsert(value: Record<string, unknown>) { stored = value; return { error: null }; },
    select() { return this; },
    eq(column: string, value: unknown) { filters.push([column, value]); return this; },
    order() { return this; },
    limit() { return this; },
    async maybeSingle() { return { data: { summary }, error: null }; },
  };
  const databaseClient = { from: () => query } as never;
  await saveSummary(summary as never, { repositoryRevision: "job-1:1", databaseClient });
  assert.equal(stored?.repository, "acme/api");
  assert.equal(stored?.repository_revision, "job-1:1");
  assert.equal(stored?.summary_kind, "intelligence");
  assert.deepEqual(await loadSummary("acme/api", { repositoryRevision: "job-1:1", databaseClient }), summary);
  assert.deepEqual(filters, [
    ["repository", "acme/api"],
    ["summary_kind", "intelligence"],
    ["repository_revision", "job-1:1"],
  ]);
});
