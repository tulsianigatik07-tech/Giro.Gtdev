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
