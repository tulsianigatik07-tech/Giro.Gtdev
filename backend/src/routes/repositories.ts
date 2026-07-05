// POST /repos/connect — clone + scan a GitHub repository.

import { Hono } from "hono";
import { z } from "zod";
import { existsSync } from "node:fs";
import { parseRepoUrl } from "../lib/parseRepoUrl.js";
import { ok, fail } from "../lib/response.js";
import { logger } from "../lib/logger.js";
import { cloneRepo, repoClonePath } from "../services/repository/clone.js";
import { scanRepo } from "../services/repository/scanner.js";
import { analyzeRepository } from "../services/repository/analyzer.js";
import { extractRepoSymbols } from "../services/graph/symbolExtractor.js";
import { buildRepositoryContext } from "../services/context/contextBuilder.js";
import { buildRepositorySummary } from "../services/intelligence/summaryBuilder.js";
import { buildRepositoryIntelligence } from "../services/repository/repositoryIntelligenceService.js";
import { saveSummary, loadSummary } from "../services/intelligence/summaryStore.js";
import { analyzeRepoDependencies } from "../services/graph/index.js";
import { searchRepositoryFiles } from "../services/fileSearch/index.js";
import { saveRepositoryIntelligence } from "../services/repository/repositoryIntelligenceHistory.js";
import { buildRepositoryIntelligenceApiResponse } from "../services/repository/repositoryIntelligenceApiResponse.js";
import {
  cleanupRepository,
  getRepositorySummary,
} from "../services/repository/repositoryLifecycleManager.js";
import {
  setRepositoryOwner,
  getRepositoryOwner,
} from "../services/repository/ownershipStore.js";
import { requireRepositoryAccess } from "../services/repository/ownershipGuard.js";
import { saveRepositoryFileSnapshot, getRepositoryFileSnapshot } from "../services/repository/fileSnapshotStore.js";
import { buildRepositoryIndexingPlan } from "../services/repository/indexingPlan.js";
import { executeIndexingPlan } from "../services/repository/indexingExecutor.js";
import {
  buildIndexCleanupPlanFromIndexingPlan,
  executeIndexCleanup,
} from "../services/repository/indexCleanup.js";
import { removeRepositorySymbolsForFiles, saveRepositorySymbols, symbolRecordsFromFileMaps } from "../services/repository/symbolIndexStore.js";
import { getAuthenticatedUser } from "../services/auth/authContext.js";
import type { AuthenticatedUser } from "../services/auth/authTypes.js";
import {
  getRepositoryIndexMetadata,
  isRepositoryHealthy,
  isRepositoryStale,
  setRepositoryIndexing,
  setRepositoryIndexed,
  setRepositoryFailed,
  touchRepositoryAccess,
  listIndexedRepositories,
} from "../services/repository/indexingService.js";
import type { ScanResult } from "../services/repository/types.js";

const ConnectBody = z.object({ repoUrl: z.string().min(1) });

type Variables = { requestId: string; authenticatedUser: AuthenticatedUser };

export const repositoriesRoute = new Hono<{ Variables: Variables }>();

repositoriesRoute.post("/connect", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ConnectBody.safeParse(body);
  if (!parsed.success) {
    return fail(c, { code: "validation_error", message: "repoUrl is required" }, 400);
  }

  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseRepoUrl(parsed.data.repoUrl));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid repository URL";
    return fail(c, { code: "invalid_repo_url", message }, 400);
  }

  const user = getAuthenticatedUser(c);
  if (!user) {
    return fail(c, { code: "unauthorized", message: "Authentication required" }, 401);
  }
  const repoId = `${owner}/${repo}`;

  // Skip-if-indexed guard: a healthy index short-circuits re-ingestion.
  // A stale index falls through and re-indexes.
  const existing = getRepositoryIndexMetadata(owner, repo);
  if (existing && isRepositoryHealthy(owner, repo)) {
    // Enforce ownership before returning the existing index to this user.
    const access = requireRepositoryAccess({ repoId, userId: user.userId });
    if (!access.ok) {
      return fail(c, { code: access.code, message: access.message }, access.status);
    }
    touchRepositoryAccess(owner, repo);
    return ok(c, {
      skipped: true,
      reason: "already_indexed",
      owner,
      repo,
      status: existing.status,
      indexedAt: existing.indexedAt,
    });
  }
  const reindexingStale = existing !== null && isRepositoryStale(owner, repo);
  if (reindexingStale) {
    logger.info("repos_reindex_stale", { requestId: c.get("requestId"), owner, repo });
  }

  setRepositoryIndexing(owner, repo);

  try {
    const { clonePath, alreadyExisted } = await cloneRepo(owner, repo);
    const stats = await scanRepo(clonePath);
    const analysis = await analyzeRepository(clonePath, stats);

    // Extract repository symbols from the freshly cloned/scanned source. If
    // this throws, the existing catch runs setRepositoryFailed and no symbols
    // are persisted (a failed index never partially writes a symbol set).
    const symbolMaps = await extractRepoSymbols(clonePath);
    const symbolCount = symbolMaps.reduce((n, m) => n + m.symbols.length, 0);

    const result: ScanResult = {
      owner,
      repo,
      clonePath,
      alreadyExisted,
      totalFiles: stats.totalFiles,
      totalDirectories: stats.totalDirectories,
      languages: stats.languages,
      tree: stats.tree,
    };

    // Build the incremental indexing plan from the PREVIOUS snapshot, before
    // the new snapshot overwrites it below. Planning/recording only — no
    // partial re-embedding happens here.
    const previousSnapshot = getRepositoryFileSnapshot(repoId);
    const indexingPlan = buildRepositoryIndexingPlan({
      previousSnapshot,
      currentFiles: stats.files,
    });
    logger.info("repository_indexing_plan", {
      requestId: c.get("requestId"),
      owner,
      repo,
      mode: indexingPlan.mode,
      totalChangedFiles: indexingPlan.totalChangedFiles,
      reason: indexingPlan.reason,
    });

    // Execute the plan: analyze only the files the plan selects. Full reindex
    // analyzes every file; incremental analyzes only changed (added) files and
    // skips unchanged ones. Per-file analysis here records a lightweight file
    // descriptor — the seam future commits (chunking/embedding) will expand.
    const execution = await executeIndexingPlan({
      plan: indexingPlan,
      currentFiles: stats.files,
      analyzeFile: (file) => ({
        filePath: file.filePath,
        language: file.language,
        size: file.size,
      }),
    });
    logger.info("repository_indexing_execution", {
      requestId: c.get("requestId"),
      owner,
      repo,
      mode: execution.mode,
      analyzed: execution.analyzedFiles.length,
      skipped: execution.skippedFiles.length,
    });

    setRepositoryIndexed(
      owner,
      repo,
      {
        chunkCount: 0,
        fileCount: stats.totalFiles ?? 0,
        symbolCount,
        graphNodeCount: 0,
        graphEdgeCount: 0,
        summaryAvailable: analysis.framework !== "unknown",
      },
      {
        indexMode: indexingPlan.mode,
        changedFileCount: indexingPlan.totalChangedFiles,
      },
    );
    touchRepositoryAccess(owner, repo);
    // The connecting user becomes the repository owner.
    setRepositoryOwner(repoId, user.userId);

    // Deletion cleanup foundation: if the plan dropped files, resolve what
    // needs cleaning BEFORE the new snapshot overwrites the old one. This is
    // foundation-only — no disk/store deletions happen yet.
    const cleanupPlan = buildIndexCleanupPlanFromIndexingPlan(indexingPlan);
    if (cleanupPlan.cleanupRequired) {
      const cleanup = executeIndexCleanup(cleanupPlan);
      // Drop stale symbol records for removed files (no-op until symbol
      // extraction output is persisted into the store in a later commit).
      removeRepositorySymbolsForFiles(repoId, cleanup.removedFiles);
      logger.info("repository_index_cleanup", {
        requestId: c.get("requestId"),
        owner,
        repo,
        cleaned: cleanup.cleanedFileCount,
        skipped: cleanup.skippedFileCount,
        reason: cleanup.reason,
      });
    }

    // Persist the extracted symbol set for this repo (atomic overwrite). Runs
    // only on the success path, so a failed index never corrupts a prior set.
    saveRepositorySymbols(repoId, symbolRecordsFromFileMaps(symbolMaps));

    // Persist the new indexed file snapshot for future incremental indexing.
    saveRepositoryFileSnapshot(repoId, stats.files);

    return ok(c, { ...result, ...analysis });
  } catch (err) {
    setRepositoryFailed(owner, repo);
    const message = err instanceof Error ? err.message : "unknown error";
    const code = message.startsWith("Clone failed") ? "clone_error" : "filesystem_error";
    logger.error("repos_connect_failed", { requestId: c.get("requestId"), message });
    return fail(c, { code, message }, 500);
  }
});

repositoriesRoute.get("/indexed", (c) => {
  const user = getAuthenticatedUser(c);
  if (!user) {
    return fail(c, { code: "unauthorized", message: "Authentication required" }, 401);
  }

  const repositories = listIndexedRepositories();
  const ownedRepositories = repositories.filter((repository) => {
    const repoId = `${repository.owner}/${repository.repo}`;
    return getRepositoryOwner(repoId) === user.userId;
  });

  return ok(c, {
    repositories: ownedRepositories,
    count: ownedRepositories.length,
  });
});

repositoriesRoute.post("/context", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ConnectBody.safeParse(body);
  if (!parsed.success) {
    return fail(c, { code: "validation_error", message: "repoUrl is required" }, 400);
  }

  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseRepoUrl(parsed.data.repoUrl));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid repository URL";
    return fail(c, { code: "invalid_repo_url", message }, 400);
  }

  const clonePath = repoClonePath(owner, repo);

  const ctxUser = getAuthenticatedUser(c);
  if (!ctxUser) {
    return fail(c, { code: "unauthorized", message: "Authentication required" }, 401);
  }
  const ctxAccess = requireRepositoryAccess({ repoId: `${owner}/${repo}`, userId: ctxUser.userId });
  if (!ctxAccess.ok) {
    return fail(c, { code: ctxAccess.code, message: ctxAccess.message }, ctxAccess.status);
  }

  if (!existsSync(clonePath)) {
    return fail(
      c,
      { code: "repo_not_connected", message: "Repository not connected. Call /repos/connect first." },
      404,
    );
  }

  try {
    const context = await buildRepositoryContext(clonePath, `${owner}/${repo}`);
    return ok(c, {
      repository: { owner, repo, clonePath },
      ...context,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    logger.error("repos_context_failed", { requestId: c.get("requestId"), message });
    return fail(c, { code: "context_error", message }, 500);
  }
});

// GET /repos/:id/summary — repository intelligence summary.
// :id is the clone folder name "owner--repo". ?refresh=1 forces regeneration.
repositoriesRoute.get("/:id/summary", async (c) => {
  const id = c.req.param("id");
  const refresh = c.req.query("refresh") === "1";

  if (!/^[A-Za-z0-9._-]+--[A-Za-z0-9._-]+$/.test(id)) {
    return fail(c, { code: "invalid_id", message: "id must be 'owner--repo'" }, 400);
  }

  const [owner, repo] = id.split("--") as [string, string];
  const clonePath = repoClonePath(owner, repo);
  const repository = `${owner}/${repo}`;

  const sumUser = getAuthenticatedUser(c);
  if (!sumUser) {
    return fail(c, { code: "unauthorized", message: "Authentication required" }, 401);
  }
  const sumAccess = requireRepositoryAccess({ repoId: repository, userId: sumUser.userId });
  if (!sumAccess.ok) {
    return fail(c, { code: sumAccess.code, message: sumAccess.message }, sumAccess.status);
  }

  if (!existsSync(clonePath)) {
    return fail(
      c,
      { code: "repo_not_connected", message: "Repository not connected. Call /repos/connect first." },
      404,
    );
  }

  try {
    if (!refresh) {
      const cached = await loadSummary(repository);
      if (cached) return ok(c, { ...cached, cached: true });
    }

    const summary = await buildRepositorySummary(clonePath, repository);
    await saveSummary(summary);
    return ok(c, { ...summary, cached: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    logger.error("repos_summary_failed", { requestId: c.get("requestId"), message });
    return fail(c, { code: "summary_error", message }, 500);
  }
});

// GET /repos/intelligence/:owner/:repo — unified repository intelligence payload.
repositoriesRoute.get("/intelligence/:owner/:repo", async (c) => {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");

  if (!owner || !repo) {
    return fail(
      c,
      { code: "validation_error", message: "owner and repo are required" },
      400,
    );
  }

  const user = getAuthenticatedUser(c);
  if (!user) {
    return fail(c, { code: "unauthorized", message: "Authentication required" }, 401);
  }

  const repoId = `${owner}/${repo}`;
  const access = requireRepositoryAccess({ repoId, userId: user.userId });
  if (!access.ok) {
    return fail(c, { code: access.code, message: access.message }, access.status);
  }

  const clonePath = repoClonePath(owner, repo);

  if (!existsSync(clonePath)) {
    return fail(
      c,
      {
        code: "repo_not_connected",
        message: "Repository not connected. Call POST /repos/connect first.",
      },
      404,
    );
  }

  try {
    const stats = await scanRepo(clonePath);
    const analysis = await analyzeRepository(clonePath, stats);

    const overview = {
      structure: {
        totalFiles: stats.totalFiles,
        totalSymbols: 0,
        repositoryScale:
          stats.totalFiles < 50
            ? "small"
            : stats.totalFiles < 250
              ? "medium"
              : "large",
      },
      architecture: {
        totalFiles: stats.totalFiles,
        totalDependencies: 0,
        architectureComplexity:
          analysis.framework === "unknown" ? "low" : "medium",
      },
    };

    const intelligence = buildRepositoryIntelligence({
      repositoryId: repoId,
      repositoryName: repo,
      overview: overview as never,
    });

    saveRepositoryIntelligence(intelligence);

    return ok(c, buildRepositoryIntelligenceApiResponse(intelligence));
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";

    logger.error("repository_intelligence_failed", {
      requestId: c.get("requestId"),
      owner,
      repo,
      message,
    });

    return fail(c, { code: "repository_intelligence_error", message }, 500);
  }
});


// GET /repos/dependencies/:owner/:repo — dependency graph + symbol intelligence.
repositoriesRoute.get("/dependencies/:owner/:repo", async (c) => {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");

  if (!owner || !repo) {
    return fail(
      c,
      { code: "validation_error", message: "owner and repo are required" },
      400,
    );
  }

  const depUser = getAuthenticatedUser(c);
  if (!depUser) {
    return fail(c, { code: "unauthorized", message: "Authentication required" }, 401);
  }
  const depAccess = requireRepositoryAccess({ repoId: `${owner}/${repo}`, userId: depUser.userId });
  if (!depAccess.ok) {
    return fail(c, { code: depAccess.code, message: depAccess.message }, depAccess.status);
  }

  try {
    const result = await analyzeRepoDependencies(owner, repo);
    return ok(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    if (message === "Repository not connected") {
      return fail(
        c,
        {
          code: "repo_not_connected",
          message: "Repository not connected. Call POST /repos/connect first.",
        },
        404,
      );
    }
    logger.error("dependency_analysis_failed", {
      requestId: c.get("requestId"),
      owner,
      repo,
      message,
    });
    return fail(c, { code: "dependency_error", message }, 500);
  }
});

// GET /repos/search/:owner/:repo?q=query&limit=1-50 — file-level semantic search.
repositoriesRoute.get("/search/:owner/:repo", async (c) => {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const query = c.req.query("q");
  const limitRaw = c.req.query("limit");

  if (!owner || !repo) {
    return fail(c, { code: "validation_error", message: "owner and repo are required" }, 400);
  }
  if (!query || query.trim().length === 0) {
    return fail(c, { code: "validation_error", message: "query (q) is required" }, 400);
  }

  let limit: number | undefined;
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
      return fail(c, { code: "validation_error", message: "limit must be an integer 1-50" }, 400);
    }
    limit = parsed;
  }

  const srchUser = getAuthenticatedUser(c);
  if (!srchUser) {
    return fail(c, { code: "unauthorized", message: "Authentication required" }, 401);
  }
  const srchAccess = requireRepositoryAccess({ repoId: `${owner}/${repo}`, userId: srchUser.userId });
  if (!srchAccess.ok) {
    return fail(c, { code: srchAccess.code, message: srchAccess.message }, srchAccess.status);
  }

  try {
    const result = await searchRepositoryFiles({ query, owner, repo, limit });
    return ok(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    if (message === "Repository not connected") {
      return fail(
        c,
        { code: "repo_not_connected", message: "Repository not connected. Call POST /repos/connect first." },
        404,
      );
    }
    logger.error("file_search_failed", {
      requestId: c.get("requestId"),
      owner,
      repo,
      message,
    });
    return fail(c, { code: "file_search_error", message }, 500);
  }
});

// DELETE /repos/:owner/:repo — cleanup repository lifecycle metadata.
repositoriesRoute.delete("/:owner/:repo", (c) => {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");

  if (!owner || !repo) {
    return fail(
      c,
      { code: "validation_error", message: "owner and repo are required" },
      400,
    );
  }

  const user = getAuthenticatedUser(c);
  if (!user) {
    return fail(
      c,
      { code: "unauthorized", message: "Authentication required" },
      401,
    );
  }

  const repoId = `${owner}/${repo}`;
  const access = requireRepositoryAccess({
    repoId,
    userId: user.userId,
  });

  if (!access.ok) {
    return fail(c, { code: access.code, message: access.message }, access.status);
  }

  const report = cleanupRepository({ owner, repo });

  return ok(c, report);
});

// GET /repos/:owner/:repo/dashboard — frontend-ready repository dashboard summary.
repositoriesRoute.get("/:owner/:repo/dashboard", async (c) => {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");

  if (!owner || !repo) {
    return fail(
      c,
      { code: "validation_error", message: "owner and repo are required" },
      400,
    );
  }

  const user = getAuthenticatedUser(c);

  if (!user) {
    return fail(
      c,
      { code: "unauthorized", message: "Authentication required" },
      401,
    );
  }

  const repoId = `${owner}/${repo}`;
  const access = requireRepositoryAccess({
    repoId,
    userId: user.userId,
  });

  if (!access.ok) {
    return fail(c, { code: access.code, message: access.message }, access.status);
  }

  return ok(c, getRepositorySummary({ owner, repo }));
});
