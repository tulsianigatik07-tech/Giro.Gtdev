import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { MetricsRegistry } from "../observability/metrics.js";
import { signAccessToken } from "../services/auth/jwt.js";
import type { DependencyGraph, FileSymbolMap } from "../services/graph/types.js";
import { MemoryIndexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import type { AnalysisResult } from "../services/repository/analyzer.js";
import { clearRepositoryOwners, setRepositoryOwner } from "../services/repository/ownershipStore.js";
import type { ScanStats } from "../services/repository/scanner.js";
import { buildRepositorySummaryContextChunk } from "../services/context/enrichedAssembler.js";
import { buildRepositoryArchitectureSummary } from "../services/repositorySummary/summaryBuilder.js";
import { generateRepositorySummary } from "../services/repositorySummary/repositorySummary.js";
import {
  clearRepositorySummaries,
  getRepositorySummary,
  saveRepositorySummary,
} from "../services/repositorySummary/runtimeRepositorySummary.js";
import type { RepositorySummary } from "../services/repositorySummary/summaryTypes.js";

const REPO = "acme/demo";
const USER_A = { userId: "user-a", email: "a@example.com" };
const USER_B = { userId: "user-b", email: "b@example.com" };

function scan(): ScanStats {
  return {
    totalFiles: 11,
    totalDirectories: 4,
    languages: { ".ts": 8, ".json": 2, ".yml": 1 },
    tree: ["package.json", "pnpm-lock.yaml", "tsconfig.json", "Dockerfile"],
    files: [
      { filePath: "package.json", size: 10, language: ".json" },
      { filePath: "tsconfig.json", size: 10, language: ".json" },
      { filePath: "Dockerfile", size: 10, language: "none" },
      { filePath: ".github/workflows/ci.yml", size: 10, language: ".yml" },
      { filePath: "src/index.ts", size: 10, language: ".ts" },
      { filePath: "src/routes/users.ts", size: 10, language: ".ts" },
      { filePath: "src/services/userService.ts", size: 10, language: ".ts" },
      { filePath: "src/retrieval/pipeline.ts", size: 10, language: ".ts" },
      { filePath: "src/indexing/worker.ts", size: 10, language: ".ts" },
      { filePath: "src/auth/jwt.ts", size: 10, language: ".ts" },
      { filePath: "src/db/store.ts", size: 10, language: ".ts" },
      { filePath: "src/routes/users.test.ts", size: 10, language: ".ts" },
    ],
  };
}

function analysis(): AnalysisResult {
  return {
    framework: "hono",
    packageManager: "pnpm",
    primaryLanguage: "typescript",
    monorepo: false,
    hasFrontend: false,
    hasBackend: true,
    importantFiles: ["package.json", "tsconfig.json"],
    entrypoints: ["src/index.ts"],
  };
}

function symbolMaps(): FileSymbolMap[] {
  return [
    {
      filePath: "src/routes/users.ts",
      language: "typescript",
      symbols: [{ name: "usersRoute", kind: "function", exported: true, line: 1 }],
      imports: [],
    },
    {
      filePath: "src/services/userService.ts",
      language: "typescript",
      symbols: [{ name: "UserService", kind: "class", exported: true, line: 1 }],
      imports: [],
    },
  ];
}

function graph(): DependencyGraph {
  return {
    nodes: [],
    edges: [],
    stats: {
      totalNodes: 2,
      totalEdges: 1,
      avgInDegree: 0.5,
      avgOutDegree: 0.5,
      maxInDegree: { file: "src/services/userService.ts", count: 1 },
      maxOutDegree: { file: "src/routes/users.ts", count: 1 },
    },
    insights: {
      centralModules: ["src/services/userService.ts"],
      dependencyHotspots: ["src/services/userService.ts"],
      isolatedModules: [],
      circularDependencies: [],
    },
  };
}

function summary(version = "v1"): RepositorySummary {
  return buildRepositoryArchitectureSummary({
    repositoryId: REPO,
    repositoryVersion: version,
    generatedAt: "2026-07-16T00:00:00.000Z",
    scan: scan(),
    analysis: analysis(),
    symbolMaps: symbolMaps(),
    dependencyGraph: graph(),
  });
}

async function authHeader(user = USER_A): Promise<string> {
  return `Bearer ${await signAccessToken(user)}`;
}

beforeEach(() => {
  clearRepositorySummaries();
  clearRepositoryOwners();
});

describe("repository architecture summary", () => {
  it("generates deterministic machine-readable summary sections", () => {
    const built = summary();

    expect(built.repositoryId).toBe(REPO);
    expect(built.repositoryVersion).toBe("v1");
    expect(built.purpose).toContain("hono");
    expect(built.languages.map((entry) => entry.name)).toContain("typescript");
    expect(built.frameworks.map((entry) => entry.name)).toEqual(["hono"]);
    expect(built.packageManagers.map((entry) => entry.name)).toEqual(["pnpm"]);
    expect(built.modules.map((entry) => entry.name)).toEqual(["usersRoute", "UserService"].sort());
    expect(built.entrypoints.map((entry) => entry.path)).toEqual(["src/index.ts"]);
    expect(built.apiSurface.map((entry) => entry.name)).toEqual(["usersRoute"]);
    expect(built.authentication.map((entry) => entry.path)).toContain("src/auth/jwt.ts");
    expect(built.retrieval.map((entry) => entry.path)).toContain("src/retrieval/pipeline.ts");
    expect(built.indexing.map((entry) => entry.path)).toContain("src/indexing/worker.ts");
    expect(built.dependencyOverview.totalEdges).toBe(1);
  });

  it("regenerates on repository version changes while retaining failed-index fallback", () => {
    saveRepositorySummary(summary("v1"));
    expect(getRepositorySummary(REPO, { repositoryVersion: "v1" })?.repositoryVersion).toBe("v1");
    expect(getRepositorySummary(REPO, { repositoryVersion: "v2" })).toBeNull();

    saveRepositorySummary(summary("v2"));
    expect(getRepositorySummary(REPO, { repositoryVersion: "v2" })?.repositoryVersion).toBe("v2");
    expect(getRepositorySummary(REPO)?.repositoryVersion).toBe("v2");
  });

  it("records cache hits, generation metrics, and structured logs", () => {
    const metrics = {
      generated: 0,
      observed: 0,
      hits: 0,
      incrementRepositorySummary() {
        this.generated += 1;
      },
      observeRepositorySummaryGenerationMs(milliseconds: number) {
        this.observed = milliseconds;
      },
      incrementRepositorySummaryCacheHit() {
        this.hits += 1;
      },
    };
    const events: string[] = [];

    generateRepositorySummary({
      repositoryId: REPO,
      repositoryVersion: "v1",
      generatedAt: "2026-07-16T00:00:00.000Z",
      scan: scan(),
      analysis: analysis(),
      symbolMaps: symbolMaps(),
      dependencyGraph: graph(),
    }, {
      metrics,
      logger: { info: (event) => events.push(event) },
      now: (() => {
        const values = [10, 17];
        return () => values.shift() ?? 17;
      })(),
    });

    getRepositorySummary(REPO, { metrics, logger: { info: (event) => events.push(event) } });

    expect(metrics.generated).toBe(1);
    expect(metrics.observed).toBe(7);
    expect(metrics.hits).toBe(1);
    expect(events).toContain("repository_summary_generated");
    expect(events).toContain("repository_summary_cached");
  });

  it("exposes metrics in prometheus output", () => {
    const metrics = new MetricsRegistry();
    metrics.incrementRepositorySummary();
    metrics.observeRepositorySummaryGenerationMs(12);
    metrics.incrementRepositorySummaryCacheHit();

    const output = metrics.render();
    expect(output).toContain("giro_repository_summaries_total 1");
    expect(output).toContain("giro_repository_summary_generation_ms 12");
    expect(output).toContain("giro_repository_summary_cache_hits_total 1");
  });

  it("returns summary through the authenticated ownership-protected API", async () => {
    const jobStore = new MemoryIndexingJobStore();
    const job = await jobStore.createJob({
      repositoryId: REPO,
      ownerUserId: USER_A.userId,
      repositoryOwner: "acme",
      repositoryName: "demo",
      repositoryUrl: "https://github.com/acme/demo.git",
    });
    await jobStore.markRunning(job.jobId);
    await jobStore.markSucceeded(job.jobId);
    setRepositoryOwner(REPO, USER_A.userId);
    saveRepositorySummary(summary(`${job.jobId}:1`));

    const app = createApp({ indexingJobStore: jobStore });
    const res = await app.request("/repositories/acme%2Fdemo/summary", {
      headers: { authorization: await authHeader(USER_A) },
    });
    const body = await res.json() as { success: boolean; data: { summary: RepositorySummary } };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.summary.repositoryId).toBe(REPO);
    expect(body.data.summary.repositoryVersion).toBe(`${job.jobId}:1`);
  });

  it("enforces authentication and ownership on the summary API", async () => {
    const app = createApp({ indexingJobStore: new MemoryIndexingJobStore() });
    const unauthenticated = await app.request("/repositories/acme%2Fdemo/summary");
    expect(unauthenticated.status).toBe(401);

    setRepositoryOwner(REPO, USER_A.userId);
    const forbidden = await app.request("/repositories/acme%2Fdemo/summary", {
      headers: { authorization: await authHeader(USER_B) },
    });
    expect(forbidden.status).toBe(403);
  });

  it("adds architecture summary as lightweight context before retrieval chunks", async () => {
    saveRepositorySummary(summary("v1"));

    const chunk = buildRepositorySummaryContextChunk(REPO, "v1");

    expect(chunk?.filePath).toBe("__repository_summary__");
    expect(chunk?.content).toContain("Repository architecture summary");
    expect(chunk?.source).toBe("graph");
    expect(chunk?.score).toBe(1);
  });
});
