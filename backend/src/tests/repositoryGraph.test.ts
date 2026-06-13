import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRepositoryGraph,
  type RepositoryFileInput,
} from "../services/graph/repositoryGraph.js";

test("1. empty repository -> empty graph", () => {
  assert.deepEqual(buildRepositoryGraph([]), { nodes: [], edges: [] });
});

test("2. single file, no imports/exports -> one node, zero edges", () => {
  const graph = buildRepositoryGraph([
    { filePath: "src/a.ts", content: "const x = 1;\nfunction y() {}" },
  ]);
  assert.deepEqual(graph.nodes, [{ filePath: "src/a.ts" }]);
  assert.deepEqual(graph.edges, []);
});

test("3. import relationship between two known files -> one imports edge", () => {
  const files: RepositoryFileInput[] = [
    { filePath: "src/a.ts", content: 'import { b } from "./b.js";' },
    { filePath: "src/b.ts", content: "export const b = 1;" },
  ];
  const graph = buildRepositoryGraph(files);
  assert.deepEqual(graph.edges, [
    { fromFile: "src/a.ts", toFile: "src/b.ts", relationshipType: "imports" },
  ]);
});

test("4. re-export relationship -> one exports edge", () => {
  const files: RepositoryFileInput[] = [
    { filePath: "src/index.ts", content: 'export { b } from "./b.js";' },
    { filePath: "src/b.ts", content: "export const b = 1;" },
  ];
  const graph = buildRepositoryGraph(files);
  assert.deepEqual(graph.edges, [
    { fromFile: "src/index.ts", toFile: "src/b.ts", relationshipType: "exports" },
  ]);
});

test("5. plain local export -> node only, no edge", () => {
  const graph = buildRepositoryGraph([
    { filePath: "src/a.ts", content: "export const foo = 1;\nexport default function f() {}" },
  ]);
  assert.deepEqual(graph.nodes, [{ filePath: "src/a.ts" }]);
  assert.deepEqual(graph.edges, []);
});

test("6. multiple files with mixed imports/re-exports", () => {
  const files: RepositoryFileInput[] = [
    { filePath: "src/index.ts", content: 'export * from "./a.js";\nimport "./b.js";' },
    { filePath: "src/a.ts", content: 'import { c } from "./c.js";' },
    { filePath: "src/b.ts", content: "export const b = 1;" },
    { filePath: "src/c.ts", content: "export const c = 1;" },
  ];
  const graph = buildRepositoryGraph(files);
  assert.deepEqual(graph.nodes.map((n) => n.filePath), [
    "src/a.ts",
    "src/b.ts",
    "src/c.ts",
    "src/index.ts",
  ]);
  assert.deepEqual(graph.edges, [
    { fromFile: "src/a.ts", toFile: "src/c.ts", relationshipType: "imports" },
    { fromFile: "src/index.ts", toFile: "src/a.ts", relationshipType: "exports" },
    { fromFile: "src/index.ts", toFile: "src/b.ts", relationshipType: "imports" },
  ]);
});

test("7. duplicate import lines / relationships are de-duplicated", () => {
  const files: RepositoryFileInput[] = [
    {
      filePath: "src/a.ts",
      content: 'import { b } from "./b.js";\nimport { c2 } from "./b.js";',
    },
    { filePath: "src/b.ts", content: "export const b = 1;" },
  ];
  const graph = buildRepositoryGraph(files);
  assert.equal(graph.edges.length, 1);
});

test("8. deterministic ordering; repeated calls deepEqual", () => {
  const files: RepositoryFileInput[] = [
    { filePath: "src/z.ts", content: 'import "./a.js";' },
    { filePath: "src/a.ts", content: 'export * from "./z.js";' },
  ];
  const first = buildRepositoryGraph(files);
  const second = buildRepositoryGraph(files);
  assert.deepEqual(first, second);
  assert.deepEqual(first.nodes.map((n) => n.filePath), ["src/a.ts", "src/z.ts"]);
  // edges sorted by fromFile then toFile then type
  assert.deepEqual(first.edges, [
    { fromFile: "src/a.ts", toFile: "src/z.ts", relationshipType: "exports" },
    { fromFile: "src/z.ts", toFile: "src/a.ts", relationshipType: "imports" },
  ]);
});

test("9. malformed lines are ignored without throwing", () => {
  const files: RepositoryFileInput[] = [
    {
      filePath: "src/a.ts",
      content: [
        "import",
        "import from;",
        "export from",
        "// import { x } from './b.js'",
        "this is just garbage text from nowhere",
        'import { b } from "./b.js";',
      ].join("\n"),
    },
    { filePath: "src/b.ts", content: "export const b = 1;" },
  ];
  let graph!: ReturnType<typeof buildRepositoryGraph>;
  assert.doesNotThrow(() => {
    graph = buildRepositoryGraph(files);
  });
  // Only the valid relative import resolves to an edge.
  assert.deepEqual(graph.edges, [
    { fromFile: "src/a.ts", toFile: "src/b.ts", relationshipType: "imports" },
  ]);
});

test("10. bare/package imports and unknown targets produce no edges", () => {
  const files: RepositoryFileInput[] = [
    {
      filePath: "src/a.ts",
      content: 'import x from "react";\nimport { y } from "./missing.js";',
    },
  ];
  const graph = buildRepositoryGraph(files);
  assert.deepEqual(graph.edges, []);
});

test("11. inputs are not mutated", () => {
  const files: RepositoryFileInput[] = [
    { filePath: "src/a.ts", content: 'import { b } from "./b.js";' },
    { filePath: "src/b.ts", content: "export const b = 1;" },
  ];
  const copy = JSON.parse(JSON.stringify(files));
  buildRepositoryGraph(files);
  assert.deepEqual(files, copy);
});
