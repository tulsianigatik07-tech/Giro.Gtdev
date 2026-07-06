export interface RepositoryDependencyEdge {
  from: string;
  to: string;
}

const nodes = new Set<string>();
const dependencies = new Map<string, Set<string>>();

function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function copyEdge(edge: RepositoryDependencyEdge): RepositoryDependencyEdge {
  return {
    from: edge.from,
    to: edge.to,
  };
}

export function addNode(filePath: string): void {
  nodes.add(filePath);
}

export function removeNode(filePath: string): void {
  nodes.delete(filePath);
  dependencies.delete(filePath);

  for (const targets of dependencies.values()) {
    targets.delete(filePath);
  }
}

export function addDependency(from: string, to: string): void {
  if (from === to) return;

  addNode(from);
  addNode(to);

  const targets = dependencies.get(from) ?? new Set<string>();
  targets.add(to);
  dependencies.set(from, targets);
}

export function removeDependency(from: string, to: string): void {
  const targets = dependencies.get(from);
  if (!targets) return;

  targets.delete(to);
  if (targets.size === 0) {
    dependencies.delete(from);
  }
}

export function getDependencies(filePath: string): string[] {
  return sortedStrings(dependencies.get(filePath) ?? []);
}

export function getDependents(filePath: string): string[] {
  const dependents: string[] = [];

  for (const [from, targets] of dependencies.entries()) {
    if (targets.has(filePath)) {
      dependents.push(from);
    }
  }

  return sortedStrings(dependents);
}

export function hasCycle(): boolean {
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(filePath: string): boolean {
    if (visiting.has(filePath)) return true;
    if (visited.has(filePath)) return false;

    visiting.add(filePath);

    for (const dependency of getDependencies(filePath)) {
      if (visit(dependency)) return true;
    }

    visiting.delete(filePath);
    visited.add(filePath);

    return false;
  }

  for (const filePath of listNodes()) {
    if (visit(filePath)) return true;
  }

  return false;
}

export function listNodes(): string[] {
  return sortedStrings(nodes);
}

export function listEdges(): RepositoryDependencyEdge[] {
  const edges: RepositoryDependencyEdge[] = [];

  for (const from of sortedStrings(dependencies.keys())) {
    for (const to of sortedStrings(dependencies.get(from) ?? [])) {
      edges.push({ from, to });
    }
  }

  return edges.map(copyEdge);
}

export function clear(): void {
  nodes.clear();
  dependencies.clear();
}
