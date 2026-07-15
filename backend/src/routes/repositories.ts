// POST /repos/connect — enqueue repository indexing.

import { Hono } from "hono";
import { z } from "zod";
import { existsSync } from "node:fs";
import { parseRepoUrl } from "../lib/parseRepoUrl.js";
import { ok, fail } from "../lib/response.js";
import { logger } from "../lib/logger.js";
import { setRequestLogContext } from "../middleware/requestContext.js";
import { createValidationError } from "../lib/apiErrors.js";
import {
  CloneOptionsSchema,
  GithubRepositoryUrlSchema,
  RepositoryNameSchema,
  RepositoryOwnerSchema,
  SearchQuerySchema,
} from "../validation/repositorySchemas.js";
import { repoClonePath } from "../services/repository/clone.js";
import { scanRepo } from "../services/repository/scanner.js";
import { analyzeRepository } from "../services/repository/analyzer.js";
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
  buildRepositoryDashboardIntelligenceBundleForRepository,
} from "../services/repository/repositoryDashboardIntelligenceBundle.js";
import { buildRepositoryRecommendations } from "../services/repository/repositoryRecommendationEngine.js";
import { buildRepositoryIntelligenceReport } from "../services/repository/repositoryIntelligenceReport.js";
import { buildRepositoryIntelligencePresentation } from "../services/repository/repositoryIntelligencePresenter.js";
import {
  setRepositoryOwner,
  getRepositoryOwner,
} from "../services/repository/ownershipStore.js";
import { requireRepositoryAccess } from "../services/repository/ownershipGuard.js";
import { getAuthenticatedUser } from "../services/auth/authContext.js";
import type { AuthenticatedUser } from "../services/auth/authTypes.js";
import {
  getRepositoryIndexMetadata,
  isRepositoryStale,
  setRepositoryIndexing,
  listIndexedRepositories,
} from "../services/repository/indexingService.js";
import type { IndexingJobStore } from "../services/indexing/jobs/indexingJobStore.js";
import type { IndexingProgressPublisher } from "../services/indexing/events/indexingProgressPublisher.js";

type Variables = {
  requestId: string;
  authenticatedUser: AuthenticatedUser;
  indexingJobStore: IndexingJobStore;
  indexingProgressPublisher: IndexingProgressPublisher;
};

export const repositoriesRoute = new Hono<{ Variables: Variables }>();

const RepositoryRouteParamsSchema = z.object({
  owner: RepositoryOwnerSchema,
  repo: RepositoryNameSchema,
});

const RepositoryConnectBodySchema = z.object({
  repoUrl: GithubRepositoryUrlSchema,
  cloneOptions: CloneOptionsSchema.optional(),
});

function parseRepositoryParams(owner: string, repo: string) {
  return RepositoryRouteParamsSchema.safeParse({ owner, repo });
}

function invalidOwnerRepo(c: Parameters<typeof fail>[0]) {
  return fail(
    c,
    createValidationError({
      fieldErrors: {
        owner: ["owner is required"],
        repo: ["repo is required"],
      },
    }),
    400,
  );
}

repositoriesRoute.post("/connect", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = RepositoryConnectBodySchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, createValidationError(parsed.error.flatten()), 400);
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
  setRequestLogContext(c, { repositoryId: repoId });

  const existing = getRepositoryIndexMetadata(owner, repo);
  const ownerUserId = getRepositoryOwner(repoId);
  if (ownerUserId !== undefined && ownerUserId !== user.userId) {
    return fail(
      c,
      {
        code: "repo_not_owned",
        message: "You do not have access to this repository.",
      },
      403,
    );
  }
  const reindexingStale = existing !== null && isRepositoryStale(owner, repo);
  if (reindexingStale) {
    logger.info("repos_reindex_stale", { requestId: c.get("requestId"), owner, repo });
  }

  setRepositoryOwner(repoId, user.userId);
  const indexingJobStore = c.get("indexingJobStore");
  const job = await indexingJobStore.createJob({
    repositoryId: repoId,
    ownerUserId: user.userId,
    repositoryOwner: owner,
    repositoryName: repo,
    repositoryUrl: parsed.data.repoUrl,
    branch: parsed.data.cloneOptions?.branch ?? null,
    createdByRequestId: c.get("requestId"),
  });
  await c.get("indexingProgressPublisher").publish(job);
  setRequestLogContext(c, { repositoryId: repoId, jobId: job.jobId });
  setRepositoryIndexing(owner, repo);

  return ok(c, {
    repositoryId: repoId,
    jobId: job.jobId,
    status: "queued",
  });
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
  const parsed = RepositoryConnectBodySchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, createValidationError(parsed.error.flatten()), 400);
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
    return fail(
      c,
      createValidationError({
        fieldErrors: {
          id: ["id must be 'owner--repo'"],
        },
      }),
      400,
    );
  }

  const [ownerRaw, repoRaw] = id.split("--") as [string, string];
  const parsedId = parseRepositoryParams(ownerRaw, repoRaw);
  if (!parsedId.success) {
    return fail(c, createValidationError(parsedId.error.flatten()), 400);
  }
  const { owner, repo } = parsedId.data;
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
  const parsedParams = parseRepositoryParams(c.req.param("owner"), c.req.param("repo"));
  if (!parsedParams.success) {
    return invalidOwnerRepo(c);
  }
  const { owner, repo } = parsedParams.data;

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
  const parsedParams = parseRepositoryParams(c.req.param("owner"), c.req.param("repo"));
  if (!parsedParams.success) {
    return invalidOwnerRepo(c);
  }
  const { owner, repo } = parsedParams.data;

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
  const parsedParams = parseRepositoryParams(c.req.param("owner"), c.req.param("repo"));
  const query = c.req.query("q");
  const limitRaw = c.req.query("limit");

  if (!parsedParams.success) {
    return invalidOwnerRepo(c);
  }
  const { owner, repo } = parsedParams.data;
  const parsedQuery = SearchQuerySchema.safeParse(query ?? "");
  if (!parsedQuery.success || parsedQuery.data.length === 0) {
    return fail(
      c,
      createValidationError({
        fieldErrors: {
          q: ["query (q) is required"],
        },
      }),
      400,
    );
  }

  let limit: number | undefined;
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
      return fail(
        c,
        createValidationError({
          fieldErrors: {
            limit: ["limit must be an integer 1-50"],
          },
        }),
        400,
      );
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
    const result = await searchRepositoryFiles({ query: parsedQuery.data, owner, repo, limit });
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
  const parsedParams = parseRepositoryParams(c.req.param("owner"), c.req.param("repo"));
  if (!parsedParams.success) {
    return invalidOwnerRepo(c);
  }
  const { owner, repo } = parsedParams.data;

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

// GET /repos/:owner/:repo/dashboard/intelligence — full dashboard intelligence bundle.
repositoriesRoute.get("/:owner/:repo/dashboard/intelligence", (c) => {
  const parsedParams = parseRepositoryParams(c.req.param("owner"), c.req.param("repo"));
  if (!parsedParams.success) {
    return invalidOwnerRepo(c);
  }
  const { owner, repo } = parsedParams.data;

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

  return ok(c, buildRepositoryDashboardIntelligenceBundleForRepository(owner, repo));
});

// GET /repos/:owner/:repo/workspace — primary repository workspace payload.
repositoriesRoute.get("/:owner/:repo/workspace", (c) => {
  const parsedParams = parseRepositoryParams(c.req.param("owner"), c.req.param("repo"));
  if (!parsedParams.success) {
    return invalidOwnerRepo(c);
  }
  const { owner, repo } = parsedParams.data;

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

  if (!getRepositoryIndexMetadata(owner, repo)) {
    return fail(
      c,
      {
        code: "repo_not_connected",
        message: "Repository not connected. Call POST /repos/connect first.",
      },
      404,
    );
  }

  const bundle = buildRepositoryDashboardIntelligenceBundleForRepository(owner, repo);
  const recommendations = buildRepositoryRecommendations({
    dashboard: bundle.dashboard,
    health: bundle.health,
    aiReadiness: bundle.aiReadiness,
    insights: bundle.insights,
    timeline: bundle.timeline,
  });
  const intelligenceReport = buildRepositoryIntelligenceReport({
    dashboard: bundle.dashboard,
    health: bundle.health,
    aiReadiness: bundle.aiReadiness,
    insights: bundle.insights,
    recommendations,
    timeline: bundle.timeline,
  });
  const presentation = buildRepositoryIntelligencePresentation(intelligenceReport);

  return ok(c, {
    repositoryId: bundle.repositoryId,
    dashboard: bundle.dashboard,
    health: bundle.health,
    aiReadiness: bundle.aiReadiness,
    insights: bundle.insights,
    recommendations,
    timeline: bundle.timeline,
    intelligenceReport,
    presentation,
  });
});

// GET /repos/:owner/:repo/dashboard — frontend-ready repository dashboard summary.
repositoriesRoute.get("/:owner/:repo/dashboard", async (c) => {
  const parsedParams = parseRepositoryParams(c.req.param("owner"), c.req.param("repo"));
  if (!parsedParams.success) {
    return invalidOwnerRepo(c);
  }
  const { owner, repo } = parsedParams.data;

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
