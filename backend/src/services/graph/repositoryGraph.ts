// Lightweight, PURE, in-memory repository graph.
//
// A small complement to the richer on-disk pipeline in this folder
// (symbolExtractor.ts + graphBuilder.ts). This variant operates on an explicit
// in-memory file list (filePath + content), which is what future incremental
// indexing — working from in-memory diffs rather than disk walks — needs.
//
// Constraints: no I/O, no randomness, no timers, no AST. Deterministic
// regex extraction reusing the same relative-import resolution approach as
// graphBuilder.ts. Inputs are never mutated.

export interface RepositoryFileInput {
  filePath: string;
  content: string;
}

export interface RepositoryNode {
  filePath: string;
}

export interface RepositoryEdge {
  fromFile: string;
  toFile: string;
  relationshipType: "imports" | "exports";
}

export interface RepositoryGraph {
  nodes: RepositoryNode[];
  edges: RepositoryEdge[];
}

const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];

function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
}

// Mirrors graphBuilder.ts resolveImport: suffix probing + TS-ESM .js->.ts.
function resolveImport(
  fromFile: string,
  source: string,
  known: Set<string>,
): string | null {
  const base = dirname(fromFile);
  const joined = normalize(base ? `${base}/${source}` : source);

  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = normalize(joined + suffix);
    if (known.has(candidate)) return candidate;
  }

  const rewritten = joined.replace(/\.(js|jsx)$/, "");
  if (rewritten !== joined) {
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = normalize(rewritten + suffix);
      if (known.has(candidate)) return candidate;
    }
  }

  return null;
}

// Per-line source detection. Returns the module specifier + relationship, or
// null when the line is not an import/re-export-from statement.
const EXPORT_FROM = /^\s*export\b[^'"]*\bfrom\s*["']([^"']+)["']/;
const IMPORT_FROM = /^\s*import\b[^'"]*\bfrom\s*["']([^"']+)["']/;
const IMPORT_BARE = /^\s*import\s*["']([^"']+)["']/;

function detectRelation(
  line: string,
): { source: string; relationshipType: "imports" | "exports" } | null {
  const exp = EXPORT_FROM.exec(line);
  if (exp && exp[1]) return { source: exp[1], relationshipType: "exports" };

  const imp = IMPORT_FROM.exec(line);
  if (imp && imp[1]) return { source: imp[1], relationshipType: "imports" };

  const bare = IMPORT_BARE.exec(line);
  if (bare && bare[1]) return { source: bare[1], relationshipType: "imports" };

  return null;
}

export function buildRepositoryGraph(
  files: RepositoryFileInput[],
): RepositoryGraph {
  const known = new Set(files.map((f) => f.filePath));

  const nodes: RepositoryNode[] = [...known]
    .sort((a, b) => a.localeCompare(b))
    .map((filePath) => ({ filePath }));

  const edgeKeys = new Set<string>();
  const edges: RepositoryEdge[] = [];

  for (const file of files) {
    for (const rawLine of file.content.split("\n")) {
      const relation = detectRelation(rawLine);
      if (!relation) continue;
      // File-to-file edges only ever come from relative specifiers.
      if (!relation.source.startsWith(".")) continue;

      const target = resolveImport(file.filePath, relation.source, known);
      if (!target || target === file.filePath) continue;

      const key = `${file.filePath}\u0000${target}\u0000${relation.relationshipType}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({
        fromFile: file.filePath,
        toFile: target,
        relationshipType: relation.relationshipType,
      });
    }
  }

  edges.sort(
    (a, b) =>
      a.fromFile.localeCompare(b.fromFile) ||
      a.toFile.localeCompare(b.toFile) ||
      a.relationshipType.localeCompare(b.relationshipType),
  );

  return { nodes, edges };
}
