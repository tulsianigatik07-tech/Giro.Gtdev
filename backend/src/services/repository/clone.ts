// Shallow-clones a GitHub repository into local storage.

import { mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import { env } from "../../config/env.js";
import type { Deadline } from "../../runtime/deadline.js";

const STORAGE_ROOT = path.join(process.cwd(), ".storage", "repos");
export type CloneExecutor = (repoUrl: string, clonePath: string, timeoutMs: number) => Promise<void>;

const defaultCloneExecutor: CloneExecutor = async (repoUrl, clonePath, timeoutMs) => {
  await simpleGit({ timeout: { block: timeoutMs } }).clone(repoUrl, clonePath, ["--depth", "1"]);
};

export function repoClonePath(owner: string, repo: string): string {
  return path.join(STORAGE_ROOT, `${owner}--${repo}`);
}

export async function cloneRepo(
  owner: string,
  repo: string,
  options: { deadline?: Deadline; executeClone?: CloneExecutor } = {},
): Promise<{ clonePath: string; alreadyExisted: boolean }> {
  await mkdir(STORAGE_ROOT, { recursive: true });

  const clonePath = repoClonePath(owner, repo);

  if (existsSync(clonePath)) {
    const entries = await readdir(clonePath);
    if (entries.length > 0) {
      return { clonePath, alreadyExisted: true };
    }
  }

  const repoUrl = `https://github.com/${owner}/${repo}.git`;

  try {
    options.deadline?.throwIfExpired();
    const timeoutMs = Math.max(1, Math.min(
      env.REPOSITORY_CLONE_TIMEOUT_MS,
      options.deadline?.remainingMs() ?? env.REPOSITORY_CLONE_TIMEOUT_MS,
    ));
    await (options.executeClone ?? defaultCloneExecutor)(repoUrl, clonePath, timeoutMs);
    options.deadline?.throwIfExpired();
  } catch (err) {
    await rm(clonePath, { recursive: true, force: true });
    const message = err instanceof Error ? err.message : "unknown error";
    throw new Error(`Clone failed: ${message}`);
  }

  return { clonePath, alreadyExisted: false };
}
