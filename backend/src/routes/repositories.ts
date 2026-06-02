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
import { buildRepositoryContext } from "../services/context/contextBuilder.js";
import { buildRepositorySummary } from "../services/intelligence/summaryBuilder.js";
import { saveSummary, loadSummary } from "../services/intelligence/summaryStore.js";
import { analyzeRepoDependencies } from "../services/graph/index.js";
import { searchRepositoryFiles } from "../services/fileSearch/index.js";
import type { ScanResult } from "../services/repository/types.js";

const ConnectBody = z.object({ repoUrl: z.string().min(1) });

type Variables = { requestId: string };

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

  try {
    const { clonePath, alreadyExisted } = await cloneRepo(owner, repo);
    const stats = await scanRepo(clonePath);
    const analysis = await analyzeRepository(clonePath, stats);

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
    return ok(c, { ...result, ...analysis });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    const code = message.startsWith("Clone failed") ? "clone_error" : "filesystem_error";
    logger.error("repos_connect_failed", { requestId: c.get("requestId"), message });
    return fail(c, { code, message }, 500);
  }
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

  if (!existsSync(clonePath)) {
    return fail(
      c,
      { code: "repo_not_connected", message: "Repository not connected. Call /repos/connect first." },
      404,
    );
  }

  const repository = `${owner}/${repo}`;

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
