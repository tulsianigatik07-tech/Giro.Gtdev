import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { analyzeRepositoryIntelligence } from "../services/repositoryIntelligence/analyzer.js";
import {
  MemoryRepositoryIntelligenceStore,
  SupabaseRepositoryIntelligenceStore,
} from "../services/repositoryIntelligence/store.js";
import { RepositoryIntelligenceService } from "../services/repositoryIntelligence/service.js";
import type {
  RepositoryIntelligenceRecord,
  RepositoryIntelligenceSnapshot,
} from "../services/repositoryIntelligence/types.js";
import { validateRepositoryIntelligence } from "../services/repositoryIntelligence/validation.js";
import { deterministicIntelligenceVersion } from "../services/repositoryIntelligence/version.js";
import type {
  RepositoryGraphEdge,
  RepositoryGraphNode,
} from "../services/repositoryGraph/graphTypes.js";
import { executeHybridRetrievalV2 } from "../services/retrieval/hybridV2/pipeline.js";
import { normalizeRetrievalWeights } from "../services/retrieval/hybridV2/config.js";
import { DeterministicNoopCrossEncoder } from "../services/retrieval/hybridV2/crossEncoder.js";

const identity = (revision = "rev-1", jobId = `job-${revision}`) => ({
  repositoryId: "acme/widgets",
  revision,
  branch: "main",
  jobId,
  workerId: "worker-1",
  claimToken: `claim-${revision}`,
});

function node(input: Partial<RepositoryGraphNode> & Pick<RepositoryGraphNode, "nodeId" | "file" | "name">) {
  return {
    symbolId: input.nodeId,
    graphVersion: "graph-1",
    repositoryId: "acme/widgets",
    repositoryRevision: "rev-1",
    repositoryVersion: "rev-1",
    parserVersion: "typescript-compiler-v1",
    qualifiedName: `${input.file}:${input.name}`,
    kind: "function",
    language: "typescript",
    line: 1,
    endLine: 10,
    column: 1,
    endColumn: 1,
    exported: false,
    defaultExport: false,
    metadata: {},
    ...input,
  } satisfies RepositoryGraphNode;
}

function edge(
  edgeId: string,
  fromNodeId: string,
  toNodeId: string,
  kind: RepositoryGraphEdge["kind"] = "imports",
): RepositoryGraphEdge {
  return {
    edgeId,
    graphVersion: "graph-1",
    repositoryId: "acme/widgets",
    repositoryRevision: "rev-1",
    parserVersion: "typescript-compiler-v1",
    fromNodeId,
    toNodeId,
    fromSymbolId: fromNodeId,
    toSymbolId: toNodeId,
    kind,
    distance: 1,
    metadata: {},
  };
}

function fixture(previous: RepositoryIntelligenceSnapshot | null = null) {
  const nodes = [
    node({ nodeId: "api", file: "src/api/index.ts", name: "createWidget", exported: true, defaultExport: true }),
    node({ nodeId: "service", file: "src/service/widgetService.ts", name: "WidgetService", kind: "function", exported: true, endLine: 120 }),
    node({ nodeId: "shared", file: "src/shared/types.ts", name: "Widget", kind: "interface", exported: true }),
    node({ nodeId: "orphan", file: "src/shared/orphan.ts", name: "orphan", exported: true }),
    node({ nodeId: "duplicate-a", file: "src/shared/a.ts", name: "normalize", exported: false }),
    node({ nodeId: "duplicate-b", file: "src/shared/b.ts", name: "normalize", exported: false }),
  ];
  const edges = [
    edge("e1", "api", "service"),
    edge("e2", "service", "shared", "references"),
    edge("e3", "shared", "api"),
  ];
  return analyzeRepositoryIntelligence({
    repositoryId: "acme/widgets",
    repositoryRevision: "rev-1",
    graphVersion: "graph-1",
    embeddingVersion: "embedding-1",
    parserVersion: "typescript-compiler-v1",
    nodes,
    edges,
    files: [
      { filePath: "src/api/index.ts", size: 2_000, content: "export default createWidget; // TODO document" },
      { filePath: "src/service/widgetService.ts", size: 70_000, content: "export class WidgetService {}" },
      { filePath: "src/shared/types.ts", size: 1_000, content: "export interface Widget {}" },
      { filePath: "src/shared/orphan.ts", size: 100, content: "export const orphan = 1" },
      { filePath: "src/shared/a.ts", size: 100 },
      { filePath: "src/shared/b.ts", size: 100 },
      { filePath: "dist/generated.js", size: 10_000 },
    ],
    previous,
    changedFiles: ["src/service/widgetService.ts"],
  });
}

async function publish(
  store: MemoryRepositoryIntelligenceStore,
  snapshot: RepositoryIntelligenceSnapshot,
  revision = snapshot.repositoryRevision,
) {
  const lease = identity(revision);
  await store.begin(lease, snapshot);
  await store.stage(lease, snapshot);
  const validation = await store.validate(lease, snapshot.intelligenceVersion);
  assert.equal(validation.valid, true);
  await store.publish(lease, snapshot.intelligenceVersion);
}

test("extracts deterministic architecture, dependency graph, APIs, entrypoints, quality, and hotspots", () => {
  const first = fixture();
  const second = fixture();
  assert.deepEqual(second, first);
  assert.equal(first.intelligenceVersion, deterministicIntelligenceVersion(first));
  assert.ok(first.subsystems.length >= 3);
  assert.ok(first.architecture.dependencyGraph.length >= 2);
  assert.equal(first.symbols.publicApis.some((api) => api.name === "createWidget"), true);
  assert.deepEqual(first.symbols.entrypoints, ["src/api/index.ts"]);
  assert.ok(first.symbols.deadExports.some((name) => name.includes("orphan")));
  assert.ok(first.codeOrganization.cyclicDependencies.length > 0);
  assert.equal(first.quality.oversizedFiles[0]?.path, "src/service/widgetService.ts");
  assert.ok(first.quality.oversizedFunctions.length > 0);
  assert.ok(first.quality.duplicateImplementations.length > 0);
  assert.ok(first.quality.todoFixmeDensity > 0);
  assert.ok(first.quality.generatedCodeRatio > 0);
  assert.equal(first.evolution.changedHotspots[0]?.path, "src/service/widgetService.ts");
});

test("validation rejects duplicate IDs, invalid graphs, orphan references, inconsistent metrics, and cyclic metadata", () => {
  const snapshot = fixture();
  snapshot.subsystems.push(structuredClone(snapshot.subsystems[0]!));
  snapshot.subsystems[0]!.dependencies.push("subsystem:missing");
  snapshot.architecture.dependencyGraph.push({ from: "bad", to: "bad", count: 0 });
  snapshot.metrics.generatedSubsystems = 0;
  const validation = validateRepositoryIntelligence(snapshot, snapshot.intelligenceVersion, "now");
  assert.equal(validation.valid, false);
  assert.deepEqual(new Set(validation.diagnostics.map((item) => item.code)), new Set([
    "duplicate_subsystem_id",
    "orphan_subsystem_reference",
    "invalid_dependency_graph",
    "metric_inconsistency",
    "cyclic_publication_metadata",
  ]));
});

test("publication is atomic to readers, rollback preserves prior intelligence, and restart recovery records failure", async () => {
  const store = new MemoryRepositoryIntelligenceStore();
  const first = fixture();
  await publish(store, first);
  assert.equal((await store.loadPublished("acme/widgets"))?.intelligenceVersion, first.intelligenceVersion);

  const second = { ...fixture(first), repositoryRevision: "rev-2" };
  second.intelligenceVersion = deterministicIntelligenceVersion(second);
  const secondIdentity = identity("rev-2");
  await store.begin(secondIdentity, second);
  await store.stage(secondIdentity, second);
  assert.equal((await store.loadPublished("acme/widgets"))?.intelligenceVersion, first.intelligenceVersion);
  await store.fail(secondIdentity, second.intelligenceVersion, [{ code: "analysis_failed", message: "failed" }]);
  assert.equal((await store.loadPublished("acme/widgets"))?.intelligenceVersion, first.intelligenceVersion);

  const third = { ...second, repositoryRevision: "rev-3" };
  third.intelligenceVersion = deterministicIntelligenceVersion(third);
  await store.begin(identity("rev-3"), third);
  assert.equal(await store.recover(), 1);
  assert.equal((await store.loadPublished("acme/widgets"))?.intelligenceVersion, first.intelligenceVersion);
  await store.verify();
});

test("retention preserves current, rollback, and building versions under concurrent cleanup", async () => {
  const store = new MemoryRepositoryIntelligenceStore();
  const versions: RepositoryIntelligenceSnapshot[] = [];
  for (let index = 1; index <= 4; index += 1) {
    const snapshot = { ...fixture(), repositoryRevision: `rev-${index}` };
    snapshot.intelligenceVersion = deterministicIntelligenceVersion(snapshot);
    await publish(store, snapshot, snapshot.repositoryRevision);
    versions.push(snapshot);
  }
  const building = { ...fixture(), repositoryRevision: "rev-building" };
  building.intelligenceVersion = deterministicIntelligenceVersion(building);
  await store.begin(identity("rev-building"), building);
  const removed = await Promise.all([store.collect("acme/widgets", 2), store.collect("acme/widgets", 2)]);
  assert.ok(removed.reduce((sum, count) => sum + count, 0) >= 1);
  assert.equal((await store.loadPublished("acme/widgets"))?.intelligenceVersion, versions.at(-1)?.intelligenceVersion);
  assert.equal((await store.begin(identity("rev-building"), building)).alreadyPublished, false);
});

test("memory and Supabase stores expose equivalent published records and query methods hide diagnostics", async () => {
  const memory = new MemoryRepositoryIntelligenceStore();
  const snapshot = fixture();
  await publish(memory, snapshot);
  const record = await memory.loadPublished("acme/widgets");
  assert.ok(record);
  const client = {
    rpc: (name: string) => ({
      then: (resolve: (value: unknown) => unknown) => resolve({
        data: name === "get_published_repository_intelligence" ? [{
          ...record,
          intelligence_version: record.intelligenceVersion,
          repository_id: record.repositoryId,
          repository_revision: record.repositoryRevision,
          graph_version: record.graphVersion,
          embedding_version: record.embeddingVersion,
          parser_version: record.parserVersion,
          analysis_version: record.analysisVersion,
          snapshot,
          publication_metadata: record.publicationMetadata,
          created_at: record.createdAt,
          validated_at: record.validatedAt,
          published_at: record.publishedAt,
        }] : null,
        error: null,
      }),
    }),
  };
  const postgres = new SupabaseRepositoryIntelligenceStore(client as never);
  assert.deepEqual(await postgres.loadPublished("acme/widgets"), record);
  const service = new RepositoryIntelligenceService(memory);
  assert.deepEqual(await service.getEntrypoints("acme/widgets"), snapshot.symbols.entrypoints);
  assert.deepEqual(await service.getPublicApi("acme/widgets"), snapshot.symbols.publicApis);
  assert.equal("diagnostics" in (await service.getRepositoryOverview("acme/widgets") ?? {}), false);
});

test("Hybrid Retrieval V2 uses matching intelligence only as a candidate ranking hint", async () => {
  const snapshot = fixture();
  const record: RepositoryIntelligenceRecord = {
    ...snapshot,
    status: "published",
    createdAt: "created",
    validatedAt: "validated",
    publishedAt: "published",
    publicationMetadata: {
      repositoryRevision: snapshot.repositoryRevision,
      graphVersion: snapshot.graphVersion,
      embeddingVersion: snapshot.embeddingVersion,
      previousIntelligenceVersion: null,
    },
  };
  const config = {
    weights: normalizeRetrievalWeights({
      semanticSimilarity: 0,
      lexicalSimilarity: 0,
      symbolMatch: 0,
      pathSimilarity: 0,
      fileImportance: 0,
      repositoryImportance: 1,
      dependencyGraphImportance: 0,
      freshness: 0,
      revisionMatch: 0,
    }),
    maxChunks: 10,
    maxFiles: 10,
    maxSymbols: 10,
    maxTokens: 10_000,
    maxPerFile: 2,
    rerankerWeight: 0,
    rerankerProvider: "deterministic" as const,
    rerankerModel: "test",
  };
  const candidate = (filePath: string, chunkId: string) => ({
    source: "semantic" as const,
    result: {
      repository: "acme/widgets",
      filePath,
      language: "typescript",
      content: chunkId,
      startLine: 1,
      endLine: 1,
      score: 0.5,
      source: "semantic" as const,
      signals: { semantic: 0.5 },
      chunkId,
    },
  });
  const input = {
    query: "widgets",
    repositoryId: "acme/widgets",
    repositoryRevision: "rev-1",
    candidates: [
      candidate("src/unimportant.ts", "a"),
      candidate("src/service/widgetService.ts", "b"),
    ],
    artifacts: null,
    limit: 2,
  };
  const withIntelligence = await executeHybridRetrievalV2(
    { ...input, intelligence: record },
    { config, crossEncoder: new DeterministicNoopCrossEncoder() },
  );
  const fallback = await executeHybridRetrievalV2(
    { ...input, intelligence: null },
    { config, crossEncoder: new DeterministicNoopCrossEncoder() },
  );
  assert.equal(withIntelligence.results[0]?.chunkId, "b");
  assert.equal(fallback.results.length, 2);
});

test("repository intelligence migration defines lifecycle, constraints, RLS, grants, retention, and atomic publication", async () => {
  const migration = await readFile(
    new URL("../../supabase/migrations/20260806000000_add_repository_intelligence_engine.sql", import.meta.url),
    "utf8",
  );
  for (const table of [
    "repository_intelligence_versions",
    "repository_intelligence_snapshots",
    "repository_intelligence_subsystems",
    "repository_intelligence_metrics",
    "repository_intelligence_diagnostics",
    "repository_intelligence_publications",
  ]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migration, /status in \('building', 'validating', 'published', 'failed', 'superseded'\)/);
  assert.match(migration, /perform public\.publish_repository_snapshot_without_intelligence[\s\S]+insert into public\.repository_intelligence_publications/);
  assert.match(migration, /rollback_intelligence_version/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /on delete cascade/);
  assert.match(migration, /grant execute[\s\S]+to service_role/);
  assert.match(migration, /verify_repository_intelligence_contract/);
});
