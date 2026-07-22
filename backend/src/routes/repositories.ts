// POST /repos/connect — enqueue repository indexing.

import { Hono } from "hono";
import { z } from "zod";
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
  getRepositorySummary,
} from "../services/repository/repositoryLifecycleManager.js";
import { buildRepositoryCleanupPlanAsync } from "../services/repository/repositoryCleanupPlanner.js";
import { describeRepositoryCleanupPlan, executeRepositoryCleanupPlan } from "../services/repository/repositoryCleanupExecutor.js";
import { buildRepositoryCleanupReport } from "../services/repository/repositoryCleanupReport.js";
import { runtimeRepositoryDeletionService } from "../services/repository/repositoryDeletionService.js";
import {
  buildRepositoryDashboardIntelligenceBundleForRepository,
} from "../services/repository/repositoryDashboardIntelligenceBundle.js";
import { buildRepositoryRecommendations } from "../services/repository/repositoryRecommendationEngine.js";
import { buildRepositoryIntelligenceReport } from "../services/repository/repositoryIntelligenceReport.js";
import { buildRepositoryIntelligencePresentation } from "../services/repository/repositoryIntelligencePresenter.js";
import {
  setRepositoryOwner,
} from "../services/repository/ownershipStore.js";
import { authorizeRepositoryConnection, validatePublishedRepositoryCheckout } from "../services/repository/ownershipGuard.js";
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
import type { RetrievalCache } from "../services/retrieval/cache/retrievalCache.js";
import { authorizeRepositoryRequest } from "../services/security/repositoryRequestGuard.js";
import { isRepositoryPathSecurityError } from "../services/security/repositoryPaths.js";
import { repositoryStore } from "../services/repository/store/runtimeRepositoryStore.js";
import { currentTraceContext, formatTraceparent } from "../observability/tracing.js";

type Variables = {
  requestId: string;
  authenticatedUser: AuthenticatedUser;
  indexingJobStore: IndexingJobStore;
  indexingProgressPublisher: IndexingProgressPublisher;
  retrievalCache: RetrievalCache;
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

  const connection = await authorizeRepositoryConnection({
    repositoryId: repoId,
    userId: user.userId,
    log: { requestId: c.get("requestId"), route: c.req.path, operation: "repository_connect" },
  });
  if (!connection.ok) return fail(c, { code: connection.code, message: connection.message }, connection.status);
  ({ owner, repo } = connection.identity);
  const existing = await getRepositoryIndexMetadata(owner, repo);
  const reindexingStale = existing !== null && await isRepositoryStale(owner, repo);
  if (reindexingStale) {
    logger.info("repos_reindex_stale", { requestId: c.get("requestId"), owner, repo });
  }

  await setRepositoryOwner(repoId, user.userId);
  const indexingJobStore = c.get("indexingJobStore");
  const trace = currentTraceContext();
  const job = await indexingJobStore.createJob({
    repositoryId: repoId,
    ownerUserId: user.userId,
    repositoryOwner: owner,
    repositoryName: repo,
    repositoryUrl: parsed.data.repoUrl,
    branch: parsed.data.cloneOptions?.branch ?? null,
    createdByRequestId: c.get("requestId"),
    ...(trace ? { createdByTraceparent: formatTraceparent(trace) } : {}),
  });
  await c.get("indexingProgressPublisher").publish(job);
  setRequestLogContext(c, { repositoryId: repoId, jobId: job.jobId });
  await setRepositoryIndexing(owner, repo);

  logger.info("repository_connected", {
    requestId: c.get("requestId"),
    userId: user.userId,
    repositoryId: repoId,
    jobId: job.jobId,
  });

  return ok(c, {
    repositoryId: repoId,
    jobId: job.jobId,
    status: "queued",
  });
});

repositoriesRoute.get("/indexed", async (c) => {
  const user = getAuthenticatedUser(c);
  if (!user) {
    return fail(c, { code: "unauthorized", message: "Authentication required" }, 401);
  }

  const repositories = await listIndexedRepositories();
  const durable = await repositoryStore.listRepositories();
  const ownedIds = new Set(durable.filter((repository) => repository.ownerUserId === user.userId).map((repository) => repository.repositoryId));
  const ownedRepositories = repositories.filter((repository) => ownedIds.has(`${repository.owner}/${repository.repo}`));

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

  const ctxAccess = await authorizeRepositoryRequest(c, `${owner}/${repo}`, "repository_context");
  if (!ctxAccess.ok) return ctxAccess.response;
  let clonePath;
  try {
    clonePath = await validatePublishedRepositoryCheckout(ctxAccess.repository);
  } catch {
    return fail(
      c,
      { code: "repo_not_connected", message: "Repository not connected. Call /repos/connect first." },
      404,
    );
  }

  try {
    if (!ctxAccess.repository.indexedRevision) {
      return fail(c, { code: "repository_not_ready", message: "Repository indexing is not ready." }, 409);
    }
    const context = await buildRepositoryContext(clonePath, ctxAccess.repository.repositoryId, {
      repositoryVersion: ctxAccess.repository.indexedRevision,
    });
    return ok(c, {
      repository: { owner: ctxAccess.repository.owner, repo: ctxAccess.repository.repo, clonePath: ctxAccess.repository.checkoutKey },
      ...context,
    });
  } catch (err) {
    logger.error("repos_context_failed", {
      requestId: c.get("requestId"),
      repositoryId: ctxAccess.repository.repositoryId,
      reasonCode: "context_build_failed",
    });
    return fail(c, { code: "context_error", message: "Repository context could not be built." }, 500);
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
  const repository = `${owner}/${repo}`;
  const sumAccess = await authorizeRepositoryRequest(c, repository, "repository_summary");
  if (!sumAccess.ok) return sumAccess.response;
  let clonePath;
  try {
    clonePath = await validatePublishedRepositoryCheckout(sumAccess.repository);
  } catch {
    return fail(
      c,
      { code: "repo_not_connected", message: "Repository not connected. Call /repos/connect first." },
      404,
    );
  }

  try {
    if (!refresh) {
      const cached = await loadSummary(repository, {
        repositoryRevision: sumAccess.repository.indexedRevision ?? undefined,
      });
      if (cached) return ok(c, { ...cached, cached: true });
    }

    const summary = await buildRepositorySummary(clonePath, repository);
    await saveSummary(summary, {
      repositoryRevision: sumAccess.repository.indexedRevision ?? undefined,
    });
    return ok(c, { ...summary, cached: false });
  } catch (err) {
    logger.error("repos_summary_failed", {
      requestId: c.get("requestId"),
      repositoryId: sumAccess.repository.repositoryId,
      reasonCode: "summary_build_failed",
    });
    return fail(c, { code: "summary_error", message: "Repository summary could not be built." }, 500);
  }
});

// GET /repos/intelligence/:owner/:repo — unified repository intelligence payload.
repositoriesRoute.get("/intelligence/:owner/:repo", async (c) => {
  const parsedParams = parseRepositoryParams(c.req.param("owner"), c.req.param("repo"));
  if (!parsedParams.success) {
    return invalidOwnerRepo(c);
  }
  const { owner, repo } = parsedParams.data;

  const repoId = `${owner}/${repo}`;
  const access = await authorizeRepositoryRequest(c, repoId, "repository_intelligence");
  if (!access.ok) return access.response;
  let clonePath;
  try {
    clonePath = await validatePublishedRepositoryCheckout(access.repository);
  } catch {
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
      indexMetadata: await getRepositoryIndexMetadata(owner, repo),
    });

    saveRepositoryIntelligence(intelligence);

    return ok(c, buildRepositoryIntelligenceApiResponse(intelligence));
  } catch (err) {
    logger.error("repository_intelligence_failed", {
      requestId: c.get("requestId"),
      owner,
      repo,
      reasonCode: "repository_intelligence_failed",
    });

    return fail(c, { code: "repository_intelligence_error", message: "Repository intelligence could not be built." }, 500);
  }
});


// GET /repos/dependencies/:owner/:repo — dependency graph + symbol intelligence.
repositoriesRoute.get("/dependencies/:owner/:repo", async (c) => {
  const parsedParams = parseRepositoryParams(c.req.param("owner"), c.req.param("repo"));
  if (!parsedParams.success) {
    return invalidOwnerRepo(c);
  }
  const { owner, repo } = parsedParams.data;

  const depAccess = await authorizeRepositoryRequest(c, `${owner}/${repo}`, "repository_dependencies");
  if (!depAccess.ok) return depAccess.response;

  try {
    await validatePublishedRepositoryCheckout(depAccess.repository);
    const result = await analyzeRepoDependencies(depAccess.repository);
    return ok(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    if (message === "Repository not connected" || isRepositoryPathSecurityError(err)) {
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
      reasonCode: "dependency_analysis_failed",
    });
    return fail(c, { code: "dependency_error", message: "Repository dependencies could not be analyzed." }, 500);
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

  const srchAccess = await authorizeRepositoryRequest(c, `${owner}/${repo}`, "repository_file_search");
  if (!srchAccess.ok) return srchAccess.response;

  try {
    await validatePublishedRepositoryCheckout(srchAccess.repository);
    const result = await searchRepositoryFiles({
      query: parsedQuery.data,
      owner: srchAccess.repository.owner,
      repo: srchAccess.repository.repo,
      limit,
    }, srchAccess.repository);
    return ok(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    if (message === "Repository not connected" || isRepositoryPathSecurityError(err)) {
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
      reasonCode: "repository_file_search_failed",
    });
    return fail(c, { code: "file_search_error", message: "Repository file search failed." }, 500);
  }
});

// DELETE /repos/:owner/:repo — cleanup repository lifecycle metadata.
repositoriesRoute.delete("/:owner/:repo", async (c) => {
  const parsedParams = parseRepositoryParams(c.req.param("owner"), c.req.param("repo"));
  if (!parsedParams.success) {
    return invalidOwnerRepo(c);
  }
  const { owner, repo } = parsedParams.data;

  const repoId = `${owner}/${repo}`;
  const user = getAuthenticatedUser(c);
  if (!user) return fail(c, { code: "unauthorized", message: "Authentication required" }, 401);
  const existingTombstone = await runtimeRepositoryDeletionService.tombstone(repoId);
  if (existingTombstone) {
    if (existingTombstone.ownerUserId !== user.userId) {
      return fail(c, { code: "repo_not_connected", message: "Repository not connected. Call POST /repos/connect first." }, 404);
    }
    const repeated = await runtimeRepositoryDeletionService.delete({
      repositoryId: repoId,
      ownerUserId: user.userId,
      expectedVersion: existingTombstone.deletedRepositoryVersion,
      report: existingTombstone.responseReport as ReturnType<typeof buildRepositoryCleanupReport>,
    });
    return ok(c, repeated.report);
  }
  const access = await authorizeRepositoryRequest(c, repoId, "repository_delete");
  if (!access.ok) return access.response;
  const record = await repositoryStore.getRepository(repoId);
  if (!record) return fail(c, { code: "repo_not_connected", message: "Repository not connected. Call POST /repos/connect first." }, 404);
  const plan = await buildRepositoryCleanupPlanAsync(owner, repo);
  const report = buildRepositoryCleanupReport(describeRepositoryCleanupPlan(plan));
  try {
    await runtimeRepositoryDeletionService.delete({
      repositoryId: repoId,
      ownerUserId: user.userId,
      expectedVersion: record.persistenceVersion ?? 1,
      report,
    });
  } catch (error) {
    logger.error("repository_deletion_transaction_failed", {
      requestId: c.get("requestId"),
      userId: access.repository.authenticatedUserId,
      repositoryId: access.repository.repositoryId,
      route: c.req.path,
      operation: "repository_delete",
      reasonCode: "durable_deletion_failed",
    });
    return fail(c, { code: "repository_deletion_failed", message: "Repository deletion could not be completed." }, 500);
  }
  executeRepositoryCleanupPlan(plan);
  try {
    c.get("retrievalCache").invalidateRepository(repoId, "repository_deleted");
  } catch {
    logger.error("retrieval_cache_invalidation_failed", {
      requestId: c.get("requestId"),
      repositoryId: repoId,
      reason: "repository_deleted",
    });
  }

  logger.info("repository_deleted", {
    requestId: c.get("requestId"),
    userId: access.repository.authenticatedUserId,
    repositoryId: repoId,
  });

  return ok(c, report);
});

// GET /repos/:owner/:repo/dashboard/intelligence — full dashboard intelligence bundle.
repositoriesRoute.get("/:owner/:repo/dashboard/intelligence", async (c) => {
  const parsedParams = parseRepositoryParams(c.req.param("owner"), c.req.param("repo"));
  if (!parsedParams.success) {
    return invalidOwnerRepo(c);
  }
  const { owner, repo } = parsedParams.data;

  const repoId = `${owner}/${repo}`;
  const access = await authorizeRepositoryRequest(c, repoId, "repository_dashboard_intelligence");
  if (!access.ok) return access.response;

  return ok(c, await buildRepositoryDashboardIntelligenceBundleForRepository(owner, repo));
});

// GET /repos/:owner/:repo/workspace — primary repository workspace payload.
repositoriesRoute.get("/:owner/:repo/workspace", async (c) => {
  const parsedParams = parseRepositoryParams(c.req.param("owner"), c.req.param("repo"));
  if (!parsedParams.success) {
    return invalidOwnerRepo(c);
  }
  const { owner, repo } = parsedParams.data;

  const repoId = `${owner}/${repo}`;
  const access = await authorizeRepositoryRequest(c, repoId, "repository_workspace");
  if (!access.ok) return access.response;

  if (!await getRepositoryIndexMetadata(owner, repo)) {
    return fail(
      c,
      {
        code: "repo_not_connected",
        message: "Repository not connected. Call POST /repos/connect first.",
      },
      404,
    );
  }

  const bundle = await buildRepositoryDashboardIntelligenceBundleForRepository(owner, repo);
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

  const repoId = `${owner}/${repo}`;
  const access = await authorizeRepositoryRequest(c, repoId, "repository_dashboard");
  if (!access.ok) return access.response;

  return ok(c, await getRepositorySummary({ owner, repo }));
});
