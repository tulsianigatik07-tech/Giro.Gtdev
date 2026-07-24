import type { RepositoryGraphEdge, RepositoryGraphNode } from "../repositoryGraph/graphTypes.js";
import type { PlanDependency, PlanningDependencyKind } from "./types.js";

const EDGE_KIND: Partial<Record<RepositoryGraphEdge["kind"], PlanningDependencyKind>> = {
  imports: "imports",
  re_exports: "imports",
  calls: "calls",
  extends: "inherits",
  implements: "implements",
};

export interface DependencyPlanningResult {
  dependencies: PlanDependency[];
  orderedFiles: string[];
  independentWork: string[][];
  blockingDependencies: string[];
  circularPlans: string[][];
  orderByFile: Map<string, number>;
}

function stronglyConnectedComponents(
  nodes: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const result: string[][] = [];
  const visit = (node: string) => {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, indices.get(next)!));
      }
    }
    if (low.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let current: string;
    do {
      current = stack.pop()!;
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    result.push(component.sort((a, b) => a.localeCompare(b)));
  };
  for (const node of [...nodes].sort()) if (!indices.has(node)) visit(node);
  return result.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

export function planDependencies(input: {
  affectedFiles: readonly string[];
  nodes: readonly RepositoryGraphNode[];
  edges: readonly RepositoryGraphEdge[];
  subsystemDependencies: ReadonlyArray<{ from: string; to: string; count: number }>;
  subsystemForFile: ReadonlyMap<string, string>;
}): DependencyPlanningResult {
  const files = [...new Set(input.affectedFiles)].sort((a, b) => a.localeCompare(b));
  const affected = new Set(files);
  const nodeFile = new Map(input.nodes.map((node) => [node.nodeId, node.file]));
  const dependencies = new Map<string, PlanDependency>();
  for (const edge of [...input.edges].sort((a, b) => a.edgeId.localeCompare(b.edgeId))) {
    const kind = EDGE_KIND[edge.kind];
    if (!kind) continue;
    const fromFile = nodeFile.get(edge.fromNodeId);
    const toFile = nodeFile.get(edge.toNodeId);
    if (!fromFile || !toFile || fromFile === toFile || !affected.has(fromFile) || !affected.has(toFile)) continue;
    const dependencyId = `${kind}:${fromFile}->${toFile}`;
    dependencies.set(dependencyId, { dependencyId, fromFile, toFile, kind, blocking: true });
  }
  for (const edge of input.subsystemDependencies) {
    const fromFiles = files.filter((file) => input.subsystemForFile.get(file) === edge.from);
    const toFiles = files.filter((file) => input.subsystemForFile.get(file) === edge.to);
    if (fromFiles.length === 0 || toFiles.length === 0) continue;
    const fromFile = fromFiles[0]!;
    const toFile = toFiles[0]!;
    const dependencyId = `subsystem:${fromFile}->${toFile}`;
    if (!dependencies.has(dependencyId)) {
      dependencies.set(dependencyId, {
        dependencyId,
        fromFile,
        toFile,
        kind: "subsystem",
        blocking: true,
      });
    }
  }
  const orderedDependencies = [...dependencies.values()].sort((a, b) =>
    a.fromFile.localeCompare(b.fromFile) ||
    a.toFile.localeCompare(b.toFile) ||
    a.kind.localeCompare(b.kind));
  // A source imports/calls/extends its target, so the target must be planned first.
  const dependencyAdjacency = new Map<string, string[]>();
  for (const file of files) dependencyAdjacency.set(file, []);
  for (const dependency of orderedDependencies) {
    dependencyAdjacency.set(
      dependency.toFile,
      [...new Set([...(dependencyAdjacency.get(dependency.toFile) ?? []), dependency.fromFile])].sort(),
    );
  }
  const components = stronglyConnectedComponents(files, dependencyAdjacency);
  const componentByFile = new Map<string, number>();
  components.forEach((component, componentIndex) =>
    component.forEach((file) => componentByFile.set(file, componentIndex)));
  const componentEdges = new Map<number, Set<number>>();
  const indegree = new Map<number, number>(components.map((_, index) => [index, 0]));
  for (const [from, nextFiles] of dependencyAdjacency) {
    const fromComponent = componentByFile.get(from)!;
    for (const next of nextFiles) {
      const toComponent = componentByFile.get(next)!;
      if (fromComponent === toComponent) continue;
      const outgoing = componentEdges.get(fromComponent) ?? new Set<number>();
      if (!outgoing.has(toComponent)) {
        outgoing.add(toComponent);
        componentEdges.set(fromComponent, outgoing);
        indegree.set(toComponent, (indegree.get(toComponent) ?? 0) + 1);
      }
    }
  }
  const levels: string[][] = [];
  let ready = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id)
    .sort((a, b) => components[a]![0]!.localeCompare(components[b]![0]!));
  const orderedFiles: string[] = [];
  const orderByFile = new Map<string, number>();
  let order = 0;
  while (ready.length > 0) {
    const levelIds = [...ready];
    const levelFiles = levelIds.flatMap((id) => components[id]!).sort();
    levels.push(levelFiles);
    for (const file of levelFiles) {
      orderedFiles.push(file);
      orderByFile.set(file, order++);
    }
    const nextReady: number[] = [];
    for (const id of levelIds) {
      for (const next of componentEdges.get(id) ?? []) {
        indegree.set(next, indegree.get(next)! - 1);
        if (indegree.get(next) === 0) nextReady.push(next);
      }
    }
    ready = nextReady.sort((a, b) => components[a]![0]!.localeCompare(components[b]![0]!));
  }
  return {
    dependencies: orderedDependencies,
    orderedFiles,
    independentWork: levels,
    blockingDependencies: orderedDependencies.filter((item) => item.blocking)
      .map((item) => item.dependencyId),
    circularPlans: components.filter((component) => component.length > 1),
    orderByFile,
  };
}
