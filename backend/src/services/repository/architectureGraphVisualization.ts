export interface ArchitectureGraphNode {
  id: string;
  label: string;
  type: string;
}

export interface ArchitectureGraphEdge {
  source: string;
  target: string;
  relationship: string;
}

export interface ArchitectureGraphData {
  nodes: ArchitectureGraphNode[];
  edges: ArchitectureGraphEdge[];
}

export function buildArchitectureGraph(): ArchitectureGraphData {
  return {
    nodes: [],
    edges: [],
  };
}