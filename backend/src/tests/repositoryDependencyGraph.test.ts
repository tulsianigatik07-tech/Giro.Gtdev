import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  addDependency,
  addNode,
  clear,
  getDependencies,
  getDependents,
  hasCycle,
  listEdges,
  listNodes,
  removeDependency,
  removeNode,
} from "../services/repository/repositoryDependencyGraph.js";

beforeEach(() => {
  clear();
});

describe("repository dependency graph", () => {
  it("starts empty", () => {
    assert.deepEqual(listNodes(), []);
    assert.deepEqual(listEdges(), []);
    assert.equal(hasCycle(), false);
  });

  it("adds a node", () => {
    addNode("src/a.ts");

    assert.deepEqual(listNodes(), ["src/a.ts"]);
  });

  it("ignores duplicate nodes", () => {
    addNode("src/a.ts");
    addNode("src/a.ts");

    assert.deepEqual(listNodes(), ["src/a.ts"]);
  });

  it("removes a node and connected edges", () => {
    addDependency("src/a.ts", "src/b.ts");
    addDependency("src/c.ts", "src/a.ts");

    removeNode("src/a.ts");

    assert.deepEqual(listNodes(), ["src/b.ts", "src/c.ts"]);
    assert.deepEqual(listEdges(), []);
  });

  it("adds a dependency and its endpoint nodes", () => {
    addDependency("src/a.ts", "src/b.ts");

    assert.deepEqual(listNodes(), ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(listEdges(), [{ from: "src/a.ts", to: "src/b.ts" }]);
  });

  it("ignores duplicate dependencies", () => {
    addDependency("src/a.ts", "src/b.ts");
    addDependency("src/a.ts", "src/b.ts");

    assert.deepEqual(listEdges(), [{ from: "src/a.ts", to: "src/b.ts" }]);
  });

  it("prevents self-loops", () => {
    addDependency("src/a.ts", "src/a.ts");

    assert.deepEqual(listNodes(), []);
    assert.deepEqual(listEdges(), []);
  });

  it("removes a dependency", () => {
    addDependency("src/a.ts", "src/b.ts");
    addDependency("src/a.ts", "src/c.ts");

    removeDependency("src/a.ts", "src/b.ts");

    assert.deepEqual(listEdges(), [{ from: "src/a.ts", to: "src/c.ts" }]);
  });

  it("looks up dependencies in sorted order", () => {
    addDependency("src/a.ts", "src/c.ts");
    addDependency("src/a.ts", "src/b.ts");

    assert.deepEqual(getDependencies("src/a.ts"), ["src/b.ts", "src/c.ts"]);
  });

  it("looks up dependents in sorted order", () => {
    addDependency("src/c.ts", "src/a.ts");
    addDependency("src/b.ts", "src/a.ts");

    assert.deepEqual(getDependents("src/a.ts"), ["src/b.ts", "src/c.ts"]);
  });

  it("detects a cycle deterministically", () => {
    addDependency("src/a.ts", "src/b.ts");
    addDependency("src/b.ts", "src/c.ts");
    addDependency("src/c.ts", "src/a.ts");

    assert.equal(hasCycle(), true);
  });

  it("reports acyclic graphs", () => {
    addDependency("src/a.ts", "src/b.ts");
    addDependency("src/b.ts", "src/c.ts");
    addNode("src/d.ts");

    assert.equal(hasCycle(), false);
  });

  it("returns deterministic ordering", () => {
    addDependency("src/z.ts", "src/b.ts");
    addDependency("src/a.ts", "src/c.ts");
    addDependency("src/a.ts", "src/b.ts");

    assert.deepEqual(listNodes(), [
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/z.ts",
    ]);
    assert.deepEqual(listEdges(), [
      { from: "src/a.ts", to: "src/b.ts" },
      { from: "src/a.ts", to: "src/c.ts" },
      { from: "src/z.ts", to: "src/b.ts" },
    ]);
  });

  it("does not expose internal state", () => {
    addDependency("src/a.ts", "src/b.ts");

    const nodes = listNodes();
    nodes.push("src/mutated.ts");

    const dependencies = getDependencies("src/a.ts");
    dependencies.push("src/mutated.ts");

    const dependents = getDependents("src/b.ts");
    dependents.push("src/mutated.ts");

    const edges = listEdges();
    edges[0]!.from = "src/mutated.ts";
    edges.push({ from: "src/x.ts", to: "src/y.ts" });

    assert.deepEqual(listNodes(), ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(getDependencies("src/a.ts"), ["src/b.ts"]);
    assert.deepEqual(getDependents("src/b.ts"), ["src/a.ts"]);
    assert.deepEqual(listEdges(), [{ from: "src/a.ts", to: "src/b.ts" }]);
  });
});
