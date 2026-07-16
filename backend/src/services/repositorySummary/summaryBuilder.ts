import type { ExtractedSymbol, FileSymbolMap } from "../graph/types.js";
import type {
  RepositoryDependencyOverview,
  RepositorySummary,
  RepositorySummaryBuildInput,
  RepositorySummaryItem,
} from "./summaryTypes.js";

const CONFIG_FILE_PATTERNS = [
  /^package\.json$/,
  /^tsconfig(?:\..*)?\.json$/,
  /^vite\.config\./,
  /^vitest\.config\./,
  /^jest\.config\./,
  /^webpack\.config\./,
  /^eslint\.config\./,
  /^biome\.json$/,
  /^\.?prettierrc/,
  /^pnpm-workspace\.yaml$/,
];

const DEPLOYMENT_FILE_PATTERNS = [
  /^Dockerfile$/,
  /^docker-compose\.ya?ml$/,
  /^vercel\.json$/,
  /^fly\.toml$/,
  /^railway\.json$/,
  /^render\.yaml$/,
  /^serverless\.yml$/,
  /^kubernetes\.ya?ml$/,
  /^terraform\.tf$/,
  /^\.github\/workflows\//,
];

function item(name: string, path?: string, kind?: string, reason?: string): RepositorySummaryItem {
  return {
    name,
    ...(path ? { path } : {}),
    ...(kind ? { kind } : {}),
    ...(reason ? { reason } : {}),
  };
}

function uniq(items: RepositorySummaryItem[]): RepositorySummaryItem[] {
  const seen = new Map<string, RepositorySummaryItem>();
  for (const current of items) {
    const key = [
      current.name,
      current.path ?? "",
      current.kind ?? "",
      current.reason ?? "",
    ].join("\u0000");
    seen.set(key, current);
  }
  return [...seen.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      (a.path ?? "").localeCompare(b.path ?? "") ||
      (a.kind ?? "").localeCompare(b.kind ?? ""),
  );
}

function languageName(ext: string): string {
  const normalized = ext.toLowerCase();
  const table: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript-react",
    ".js": "javascript",
    ".jsx": "javascript-react",
    ".json": "json",
    ".md": "markdown",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".sql": "sql",
    ".css": "css",
    ".html": "html",
    none: "unknown",
  };
  return table[normalized] ?? (normalized.replace(/^\./, "") || "unknown");
}

function topLevelFiles(tree: readonly string[]): Set<string> {
  return new Set(tree.filter((entry) => !entry.includes("/")));
}

function directoriesFromFiles(files: readonly { filePath: string }[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.filePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      dirs.add(parts.slice(0, index).join("/"));
    }
  }
  return [...dirs].sort((a, b) => a.localeCompare(b));
}

function importantDirectories(input: RepositorySummaryBuildInput): RepositorySummaryItem[] {
  const dirs = directoriesFromFiles(input.scan.files);
  const scored = dirs.map((dir) => {
    let score = 0;
    let reason = "Repository directory";
    if (/^src\/routes$|^routes$/.test(dir)) {
      score = 95;
      reason = "HTTP route definitions";
    } else if (/^src\/services$|^services$/.test(dir)) {
      score = 90;
      reason = "Service layer";
    } else if (/^src\/middleware$|^middleware$/.test(dir)) {
      score = 80;
      reason = "Request middleware";
    } else if (/^apps$|^packages$/.test(dir)) {
      score = 75;
      reason = "Workspace boundary";
    } else if (/^src$/.test(dir)) {
      score = 60;
      reason = "Source root";
    } else if (/test|spec/.test(dir)) {
      score = 40;
      reason = "Test suite";
    }
    return { dir, score, reason };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.dir.localeCompare(b.dir))
    .slice(0, 15)
    .map((entry) => item(entry.dir, entry.dir, "directory", entry.reason));
}

function fileItems(
  input: RepositorySummaryBuildInput,
  predicate: (path: string) => boolean,
  kind: string,
  reason: string,
): RepositorySummaryItem[] {
  return input.scan.files
    .map((file) => file.filePath.split("\\").join("/"))
    .filter(predicate)
    .sort((a, b) => a.localeCompare(b))
    .map((path) => item(path.split("/").at(-1) ?? path, path, kind, reason));
}

function symbolItems(
  maps: readonly FileSymbolMap[],
  predicate: (map: FileSymbolMap, symbol: ExtractedSymbol) => boolean,
  reason: string,
): RepositorySummaryItem[] {
  const results: RepositorySummaryItem[] = [];
  for (const map of maps) {
    for (const symbol of map.symbols) {
      if (!predicate(map, symbol)) continue;
      results.push(item(symbol.name, map.filePath, symbol.kind, reason));
    }
  }
  return uniq(results);
}

function pathItems(
  input: RepositorySummaryBuildInput,
  predicate: (path: string) => boolean,
  kind: string,
  reason: string,
): RepositorySummaryItem[] {
  return uniq(input.scan.files
    .map((file) => file.filePath.split("\\").join("/"))
    .filter(predicate)
    .map((path) => item(path.split("/").at(-1) ?? path, path, kind, reason)));
}

function dependencyOverview(input: RepositorySummaryBuildInput): RepositoryDependencyOverview {
  const stats = input.dependencyGraph.stats;
  return {
    totalNodes: stats.totalNodes,
    totalEdges: stats.totalEdges,
    averageInDegree: Number(stats.avgInDegree.toFixed(2)),
    averageOutDegree: Number(stats.avgOutDegree.toFixed(2)),
    centralModules: [...input.dependencyGraph.insights.centralModules],
    dependencyHotspots: [...input.dependencyGraph.insights.dependencyHotspots],
    isolatedModules: [...input.dependencyGraph.insights.isolatedModules],
    circularDependencies: input.dependencyGraph.insights.circularDependencies.map((cycle) => [...cycle]),
  };
}

function purpose(input: RepositorySummaryBuildInput): string {
  const parts = [
    input.analysis.framework !== "unknown" ? input.analysis.framework : null,
    input.analysis.hasBackend ? "backend" : null,
    input.analysis.hasFrontend ? "frontend" : null,
    input.analysis.monorepo ? "monorepo" : null,
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return "Repository purpose could not be inferred from indexed metadata.";
  return `Repository appears to be a ${parts.join(", ")} project.`;
}

export function buildRepositoryArchitectureSummary(
  input: RepositorySummaryBuildInput,
): RepositorySummary {
  const topFiles = topLevelFiles(input.scan.tree);
  const configFiles = fileItems(
    input,
    (path) => CONFIG_FILE_PATTERNS.some((pattern) => pattern.test(path)),
    "configuration",
    "Configuration file",
  );
  const deployment = fileItems(
    input,
    (path) => DEPLOYMENT_FILE_PATTERNS.some((pattern) => pattern.test(path)),
    "deployment",
    "Deployment or infrastructure file",
  );

  return {
    repositoryId: input.repositoryId,
    repositoryVersion: input.repositoryVersion,
    generatedAt: input.generatedAt,
    purpose: purpose(input),
    languages: Object.entries(input.scan.languages)
      .map(([ext, count]) => item(languageName(ext), undefined, "language", `${count} indexed files`))
      .sort((a, b) => (b.reason ?? "").localeCompare(a.reason ?? "") || a.name.localeCompare(b.name)),
    frameworks: input.analysis.framework === "unknown"
      ? []
      : [item(input.analysis.framework, undefined, "framework", "Detected by repository analyzer")],
    packageManagers: input.analysis.packageManager === "unknown"
      ? []
      : [item(input.analysis.packageManager, undefined, "package-manager", "Detected from lockfiles")],
    applications: pathItems(input, (path) => /(^|\/)(app|apps|pages|src\/app|src\/pages)(\/|$)/.test(path), "application", "Application surface"),
    libraries: pathItems(input, (path) => /(^|\/)(lib|libs|packages|src\/lib)(\/|$)/.test(path), "library", "Shared library code"),
    services: pathItems(input, (path) => /(^|\/)(services|src\/services)(\/|$)/.test(path), "service", "Service layer file"),
    modules: symbolItems(input.symbolMaps, (_map, symbol) => symbol.exported, "Exported repository symbol"),
    entrypoints: uniq(input.analysis.entrypoints.map((path) => item(path.split("/").at(-1) ?? path, path, "entrypoint", "Detected entrypoint"))),
    importantDirectories: importantDirectories(input),
    configFiles,
    apiSurface: symbolItems(
      input.symbolMaps,
      (map, symbol) => symbol.exported && /(^|\/)(routes|controllers|api)(\/|$)/.test(map.filePath),
      "Exported API symbol",
    ),
    backgroundWorkers: pathItems(input, (path) => /worker|queue|job|cron|schedule/i.test(path), "background-worker", "Worker, queue, or scheduled file"),
    dataStores: pathItems(input, (path) => /prisma|migration|schema|database|db|supabase|store/i.test(path), "data-store", "Data layer file"),
    authentication: pathItems(input, (path) => /auth|jwt|session|passport|clerk/i.test(path), "authentication", "Authentication-related file"),
    retrieval: pathItems(input, (path) => /retrieval|embedding|search|context/i.test(path), "retrieval", "Retrieval or context pipeline file"),
    indexing: pathItems(input, (path) => /indexing|indexer|scanner|symbol|graph/i.test(path), "indexing", "Indexing pipeline file"),
    testing: pathItems(input, (path) => /\.test\.|\.spec\.|(^|\/)(test|tests)(__)?(\/|$)/.test(path), "testing", "Test file"),
    build: uniq([
      ...configFiles.filter((entry) => /tsconfig|vite|webpack|package|pnpm|jest|vitest/.test(entry.name)),
      ...(topFiles.has("Makefile") ? [item("Makefile", "Makefile", "build", "Build automation")] : []),
    ]),
    deployment,
    dependencyOverview: dependencyOverview(input),
  };
}
