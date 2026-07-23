import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  TypeScriptJavaScriptParser,
} from "../services/repositoryGraph/astParser.js";
import {
  buildAstRepositoryGraph,
  deterministicGraphVersion,
} from "../services/repositoryGraph/graphBuilder.js";
import {
  MemoryRepositoryGraphStore,
  SupabaseRepositoryGraphStore,
} from "../services/repositoryGraph/graphStore.js";
import {
  expandPublishedRepositoryGraph,
  type RepositoryGraphTraversalWeights,
} from "../services/repositoryGraph/graphTraversal.js";
import {
  validateRepositoryGraph,
} from "../services/repositoryGraph/graphValidation.js";
import type {
  ParsedGraphFile,
  RepositorySymbolGraph,
} from "../services/repositoryGraph/graphTypes.js";
import {
  executeHybridRetrievalV2,
} from "../services/retrieval/hybridV2/pipeline.js";
import {
  runtimeHybridRetrievalV2Config,
} from "../services/retrieval/hybridV2/config.js";
import {
  DeterministicNoopCrossEncoder,
} from "../services/retrieval/hybridV2/crossEncoder.js";

const REPOSITORY = "acme/graph";
const REVISION_A = "a".repeat(40);
const REVISION_B = "b".repeat(40);
const PARSER_VERSION = "typescript-compiler-v1";
const parser = new TypeScriptJavaScriptParser();
const weights: RepositoryGraphTraversalWeights = {
  directRelationship: 0.5,
  callEdge: 0.9,
  importEdge: 0.7,
  inheritance: 0.8,
  implementation: 0.8,
  referenceCount: 0.2,
  centrality: 0.1,
  distancePenalty: 0.1,
};

function parsedFixture(): ParsedGraphFile[] {
  return [
    parser.parse("src/base.ts", `
      export interface Printable { print(): string }
      export class BasePrinter {
        render(): string { return "base"; }
      }
    `),
    parser.parse("src/helper.js", `
      export function helper(value) { return String(value); }
    `),
    parser.parse("src/printer.ts", `
      import { Printable, BasePrinter } from "./base.js";
      import { helper } from "./helper.js";
      export class Printer extends BasePrinter implements Printable {
        constructor(readonly value: string) { super(); }
        render(): string { return helper(this.value); }
        print(): string { return this.render(); }
      }
      export const createPrinter = () => new Printer("value");
    `),
    parser.parse("src/component.tsx", `
      import { Printer } from "./printer";
      export default function Component() {
        const printer = new Printer("tsx");
        return <div>{printer.print()}</div>;
      }
    `),
    parser.parse("src/widget.jsx", `
      export const Widget = ({ label }) => <span>{label}</span>;
    `),
    parser.parse("src/index.ts", `
      export { Printer } from "./printer.js";
      export * from "./helper.js";
    `),
    parser.parse("src/named.ts", `
      const internalValue = 1;
      export { internalValue as publicValue };
    `),
  ];
}

function graph(revision = REVISION_A, parserVersion = PARSER_VERSION): RepositorySymbolGraph {
  return buildAstRepositoryGraph({
    repositoryId: REPOSITORY,
    repositoryRevision: revision,
    parserVersion,
    parsedFiles: parsedFixture(),
    durationMs: 5,
    createdAt: "2026-07-24T00:00:00.000Z",
  });
}

function published(value: RepositorySymbolGraph): RepositorySymbolGraph {
  return {
    ...structuredClone(value),
    status: "published",
    publishedAt: "2026-07-24T00:00:01.000Z",
  };
}

function identity(revision: string, jobId: string) {
  return {
    repositoryId: REPOSITORY,
    revision,
    branch: "main",
    jobId,
    workerId: "worker-1",
    claimToken: `claim-${jobId}`,
  };
}

test("TypeScript, TSX, JavaScript, and JSX AST parsing extracts declarations and relationships", () => {
  const built = graph();
  const kinds = new Set(built.nodes.map((node) => node.kind));
  assert.ok(kinds.has("class"));
  assert.ok(kinds.has("interface"));
  assert.ok(kinds.has("function"));
  assert.ok(kinds.has("method"));
  assert.ok(kinds.has("constructor"));
  assert.ok(kinds.has("variable"));
  assert.ok(built.nodes.some((node) =>
    node.name === "Component" && node.defaultExport && node.file === "src/component.tsx"));
  assert.ok(built.nodes.some((node) =>
    node.name === "Widget" && node.file === "src/widget.jsx"));
  assert.ok(built.nodes.some((node) =>
    node.name === "internalValue" && node.exported && node.file === "src/named.ts"));
  const edgeKinds = new Set(built.edges.map((edge) => edge.kind));
  for (const kind of [
    "contains", "imports", "exports", "re_exports", "references", "calls",
    "extends", "implements", "overrides", "resolves_to",
  ] as const) assert.ok(edgeKinds.has(kind), `missing ${kind}`);
  assert.equal(built.diagnostics.parserFailureCount, 0);
});

test("graph IDs and ordering are deterministic and isolated by revision and parser version", () => {
  const first = graph();
  const second = graph();
  assert.deepEqual(
    second.nodes.map((node) => node.nodeId),
    first.nodes.map((node) => node.nodeId),
  );
  assert.deepEqual(
    second.edges.map((edge) => edge.edgeId),
    first.edges.map((edge) => edge.edgeId),
  );
  assert.equal(second.graphVersion, first.graphVersion);
  assert.notEqual(graph(REVISION_B).graphVersion, first.graphVersion);
  assert.notEqual(graph(REVISION_A, "typescript-compiler-v2").graphVersion, first.graphVersion);
  assert.equal(
    first.graphVersion,
    deterministicGraphVersion(REPOSITORY, REVISION_A, PARSER_VERSION),
  );
});

test("validation detects duplicates, missing endpoints, impossible self edges, and quotas", () => {
  const validGraph = graph();
  assert.equal(validateRepositoryGraph(validGraph, {
    expectedRepositoryId: REPOSITORY,
    expectedRepositoryRevision: REVISION_A,
  }).valid, true);
  const invalid = structuredClone(validGraph);
  invalid.nodes.push(structuredClone(invalid.nodes[0]!));
  invalid.edges.push({
    ...structuredClone(invalid.edges[0]!),
    edgeId: "missing-endpoint",
    toNodeId: "does-not-exist",
    toSymbolId: "does-not-exist",
  });
  invalid.edges.push({
    ...structuredClone(invalid.edges[0]!),
    edgeId: "self-edge",
    fromNodeId: invalid.nodes[0]!.nodeId,
    toNodeId: invalid.nodes[0]!.nodeId,
    fromSymbolId: invalid.nodes[0]!.nodeId,
    toSymbolId: invalid.nodes[0]!.nodeId,
    kind: "calls",
  });
  const validation = validateRepositoryGraph(invalid, {
    expectedRepositoryId: REPOSITORY,
    expectedRepositoryRevision: REVISION_A,
  });
  assert.equal(validation.valid, false);
  assert.equal(validation.duplicateNodeIdCount, 1);
  assert.equal(validation.missingEndpointCount, 1);
  assert.equal(validation.impossibleSelfEdgeCount, 1);
  assert.throws(() => validateRepositoryGraph(validGraph, {
    expectedRepositoryId: REPOSITORY,
    expectedRepositoryRevision: REVISION_A,
    quotas: {
      maxNodes: 1,
      maxEdges: 1_000,
      maxDurationMs: 1_000,
      maxBytes: 100_000_000,
      maxUnresolvedFileRatio: 1,
      maxParserFailureRatio: 1,
    },
  }), /graph_nodes/);
});

test("memory publication is atomic, retains the previous graph on failure, and enforces revision reads", async () => {
  const store = new MemoryRepositoryGraphStore();
  const firstGraph = graph();
  const firstIdentity = identity(REVISION_A, "job-a");
  assert.equal((await store.begin(
    firstIdentity,
    firstGraph.graphVersion,
    firstGraph.parserVersion,
  )).alreadyPublished, false);
  await store.stage(firstIdentity, firstGraph);
  await store.validate(firstIdentity, firstGraph.graphVersion);
  assert.equal(await store.loadPublished(REPOSITORY, REVISION_A), null);
  await store.publish(firstIdentity, firstGraph.graphVersion);
  assert.equal(
    (await store.loadPublished(REPOSITORY, REVISION_A))?.graphVersion,
    firstGraph.graphVersion,
  );

  const secondGraph = graph(REVISION_B);
  const secondIdentity = identity(REVISION_B, "job-b");
  await store.begin(secondIdentity, secondGraph.graphVersion, secondGraph.parserVersion);
  await store.stage(secondIdentity, secondGraph);
  await store.discard(secondIdentity, secondGraph.graphVersion, { code: "parser_failed" });
  assert.equal(await store.loadPublished(REPOSITORY, REVISION_B), null);
  assert.equal(
    (await store.loadPublished(REPOSITORY, REVISION_A))?.graphVersion,
    firstGraph.graphVersion,
  );
  await store.verify();
});

test("bounded traversal is deterministic, cycle-safe, and supports callers, callees, imports, and implementations", () => {
  const current = published(graph());
  const root = [{
    repository: REPOSITORY,
    filePath: "src/printer.ts",
    language: "typescript",
    content: "class Printer",
    startLine: 4,
    endLine: 10,
    score: 1,
    source: "symbol" as const,
    signals: { symbol: 1 },
    symbol: "Printer",
  }];
  const first = expandPublishedRepositoryGraph(current, root, {
    repositoryId: REPOSITORY,
    repositoryRevision: REVISION_A,
    maxDepth: 3,
    maxCandidates: 8,
    weights,
  });
  const second = expandPublishedRepositoryGraph(current, root, {
    repositoryId: REPOSITORY,
    repositoryRevision: REVISION_A,
    maxDepth: 3,
    maxCandidates: 8,
    weights,
  });
  assert.deepEqual(second, first);
  assert.ok(first.length > 0 && first.length <= 8);
  assert.equal(new Set(first.map((candidate) => candidate.nodeId)).size, first.length);
  assert.ok(first.some((candidate) =>
    ["calls", "extends", "implements", "imports", "resolves_to"].includes(candidate.edgeKind)));
  assert.deepEqual(expandPublishedRepositoryGraph(current, root, {
    repositoryId: REPOSITORY,
    repositoryRevision: REVISION_B,
    maxDepth: 3,
    maxCandidates: 8,
    weights,
  }), []);
});

test("Hybrid Retrieval V2 integrates graph diagnostics and falls back without a matching published graph", async () => {
  const candidate = {
    source: "symbol" as const,
    result: {
      repository: REPOSITORY,
      filePath: "src/printer.ts",
      language: "typescript",
      content: "export class Printer",
      startLine: 4,
      endLine: 10,
      score: 1,
      source: "symbol" as const,
      signals: { symbol: 1 },
      chunkId: "printer",
      symbol: "Printer",
    },
  };
  const config = {
    ...runtimeHybridRetrievalV2Config,
    graphTraversal: {
      enabled: true,
      maxDepth: 2,
      maxCandidates: 6,
      weights,
    },
  };
  const withGraph = await executeHybridRetrievalV2({
    query: "who calls and implements Printer",
    repositoryId: REPOSITORY,
    repositoryRevision: REVISION_A,
    candidates: [candidate],
    artifacts: null,
    graph: published(graph()),
    limit: 10,
  }, { config, crossEncoder: new DeterministicNoopCrossEncoder() });
  assert.equal(withGraph.diagnostics.graph.used, true);
  assert.ok(withGraph.diagnostics.graph.expandedCandidates > 0);
  assert.deepEqual(withGraph.diagnostics.graph.weights, weights);
  assert.ok(withGraph.results.some((result) => result.source === "graph"));
  assert.equal("diagnostics" in withGraph.results[0]!, false);

  const fallback = await executeHybridRetrievalV2({
    query: "Printer",
    repositoryId: REPOSITORY,
    repositoryRevision: REVISION_B,
    candidates: [candidate],
    artifacts: null,
    graph: published(graph()),
    limit: 10,
  }, { config, crossEncoder: new DeterministicNoopCrossEncoder() });
  assert.equal(fallback.diagnostics.graph.used, false);
  assert.deepEqual(fallback.results.map((result) => result.chunkId), ["printer"]);
});

test("memory and Supabase graph stores expose equivalent deterministic lifecycle identities", async () => {
  const built = graph();
  const graphIdentity = identity(REVISION_A, "equivalence-job");
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const client = {
    rpc(name: string, parameters: Record<string, unknown>) {
      calls.push({ name, parameters: structuredClone(parameters) });
      const data = name === "begin_repository_graph_version"
        ? [{ already_published: false, graph_version: built.graphVersion }]
        : name === "validate_repository_graph_version"
          ? [{ valid: true, node_count: built.nodes.length, edge_count: built.edges.length }]
          : name === "get_published_repository_graph"
            ? [{
                graph_version: built.graphVersion,
                repository_id: REPOSITORY,
                repository_revision: REVISION_A,
                parser_version: built.parserVersion,
                created_at: built.createdAt,
                published_at: "2026-07-24T00:00:01.000Z",
                nodes: built.nodes,
                edges: built.edges,
                diagnostics: built.diagnostics,
              }]
            : name === "collect_repository_graph_versions"
              ? [{ deleted_version_count: 1 }]
              : name === "recover_repository_graph_versions"
                ? [{ cleaned_version_count: 2 }]
                : name === "verify_repository_graph_contract"
                  ? [{ valid: true }]
                  : null;
      return Promise.resolve({ data, error: null });
    },
  };
  const memory = new MemoryRepositoryGraphStore();
  const database = new SupabaseRepositoryGraphStore(client as never);
  const [memoryBegin, databaseBegin] = await Promise.all([
    memory.begin(graphIdentity, built.graphVersion, built.parserVersion),
    database.begin(graphIdentity, built.graphVersion, built.parserVersion),
  ]);
  assert.deepEqual(databaseBegin, memoryBegin);
  await Promise.all([
    memory.stage(graphIdentity, built),
    database.stage(graphIdentity, built),
  ]);
  const [memoryValidation, databaseValidation] = await Promise.all([
    memory.validate(graphIdentity, built.graphVersion),
    database.validate(graphIdentity, built.graphVersion),
  ]);
  assert.equal(databaseValidation.valid, memoryValidation.valid);
  await memory.publish(graphIdentity, built.graphVersion);
  const [memoryPublished, databasePublished] = await Promise.all([
    memory.loadPublished(REPOSITORY, REVISION_A),
    database.loadPublished(REPOSITORY, REVISION_A),
  ]);
  assert.equal(databasePublished?.graphVersion, memoryPublished?.graphVersion);
  assert.deepEqual(
    databasePublished?.nodes.map((node) => node.nodeId),
    memoryPublished?.nodes.map((node) => node.nodeId),
  );
  assert.equal(await database.collect(REPOSITORY, 1), 1);
  assert.equal(await database.recover(), 2);
  await database.verify();
  assert.deepEqual(calls.map((call) => call.name), [
    "begin_repository_graph_version",
    "stage_repository_graph_version",
    "validate_repository_graph_version",
    "get_published_repository_graph",
    "collect_repository_graph_versions",
    "recover_repository_graph_versions",
    "verify_repository_graph_contract",
  ]);
});

test("migration and startup contracts require durable graph integrity before serving", async () => {
  const [migration, startup] = await Promise.all([
    readFile(new URL("../../supabase/migrations/20260805000000_add_durable_repository_graphs.sql", import.meta.url), "utf8"),
    readFile(new URL("../index.ts", import.meta.url), "utf8"),
  ]);
  for (const object of [
    "repository_graph_versions", "repository_graph_nodes", "repository_graph_edges",
    "repository_graph_diagnostics", "repository_graph_publications",
    "validate_repository_graph_version", "verify_repository_graph_contract",
    "collect_repository_graph_versions", "recover_repository_graph_versions",
  ]) assert.match(migration, new RegExp(object));
  assert.match(migration, /perform public\.publish_repository_snapshot_without_graph[\s\S]+insert into public\.repository_graph_publications/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /on delete cascade/);
  const graphValidation = startup.indexOf("runtimeRepositoryGraphStore.verify");
  const serving = startup.indexOf("server = serve");
  assert.ok(graphValidation >= 0 && graphValidation < serving);
});
