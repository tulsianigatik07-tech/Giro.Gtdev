// Shallow-clones a GitHub repository into local storage.

import { readdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import { env } from "../../config/env.js";
import { createDeadline, type Deadline } from "../../runtime/deadline.js";
import { retry, isTransientTransportError, type RetryRuntimeOptions } from "../../runtime/retry.js";
import { classifyCloneFailure } from "./cloneFailureClassifier.js";
import { createRetryObservability, type RetryLogger, type RetryMetrics } from "../../observability/retryObservability.js";
import { logger } from "../../lib/logger.js";
import { runtimeMetrics } from "../../observability/metrics.js";
import type { CircuitBreaker } from "../../runtime/circuitBreaker.js";
import { runtimeDependencyCircuitBreakers } from "../../runtime/dependencyCircuitBreakers.js";
import {
  ensureRepositoryStorageRoot,
  removeRepositoryCheckout,
  repositoryCheckoutPath,
  resolveRepositoryPath,
  validateRepositoryCheckout,
  type TrustedRepositoryCheckoutPath,
} from "../security/repositoryPaths.js";
import { normalizeRepositoryParts } from "../security/repositoryIdentity.js";
import { repositoryStorageRoot } from "../../config/repositoryStorage.js";

export type CloneExecutor = (repoUrl: string, clonePath: string, timeoutMs: number) => Promise<void>;
export interface SnapshotCheckoutResult {
  commitSha: string;
  branch: string | null;
}
export type SnapshotCheckoutExecutor = (input: {
  clonePath: string;
  branch: string | null;
  reusedClone: boolean;
  timeoutMs: number;
}) => Promise<SnapshotCheckoutResult>;

const defaultCloneExecutor: CloneExecutor = async (repoUrl, clonePath, timeoutMs) => {
  await simpleGit({ timeout: { block: timeoutMs } }).clone(repoUrl, clonePath, ["--depth", "1"]);
};

const defaultSnapshotCheckoutExecutor: SnapshotCheckoutExecutor = async (input) => {
  const checkout = await validateGitWorkingDirectory(input.clonePath);
  const git = simpleGit(checkout, { timeout: { block: input.timeoutMs } });
  let resolvedBranch = input.branch;
  if (!resolvedBranch) {
    try {
      const localBranch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
      if (localBranch && localBranch !== "HEAD") resolvedBranch = localBranch;
    } catch {
      // A reused detached checkout resolves its branch from origin below.
    }
  }
  if (!resolvedBranch) {
    try {
      const remoteHead = (await git.raw([
        "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD",
      ])).trim();
      resolvedBranch = remoteHead.replace(/^origin\//, "") || null;
    } catch {
      // Some remotes do not advertise a symbolic default branch.
    }
  }
  if (input.reusedClone || resolvedBranch) {
    const ref = resolvedBranch ?? "HEAD";
    await git.fetch(["origin", ref, "--depth", "1", "--force"]);
  }
  const target = input.reusedClone || resolvedBranch ? "FETCH_HEAD" : "HEAD";
  const revision = (await git.revparse([target])).trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("Repository revision could not be resolved.");
  }
  await git.checkout(["--detach", revision]);
  await git.reset(["--hard", revision]);
  await git.clean("f", ["-d"]);
  const checkedOutRevision = (await git.revparse(["HEAD"])).trim().toLowerCase();
  if (checkedOutRevision !== revision) {
    throw new Error("Repository checkout does not match the resolved revision.");
  }
  return { commitSha: revision, branch: resolvedBranch };
};

export function repoClonePath(owner: string, repo: string): TrustedRepositoryCheckoutPath {
  return repositoryCheckoutPath(normalizeRepositoryParts(owner, repo).repositoryId);
}

export async function validateGitWorkingDirectory(
  checkoutPath: string,
  timeoutMs = env.REPOSITORY_CLONE_TIMEOUT_MS,
  storageRoot = repositoryStorageRoot,
): Promise<TrustedRepositoryCheckoutPath> {
  if (path.dirname(checkoutPath) !== storageRoot || !/^repo-[0-9a-f]{64}$/.test(path.basename(checkoutPath))) {
    throw new Error("Git working directory is not an authorized checkout.");
  }
  // Recover the trusted type only after runtime checkout and symlink validation.
  const checkout = checkoutPath as TrustedRepositoryCheckoutPath;
  await resolveRepositoryPath(checkout, ".git", { mustExist: true });
  const git = simpleGit(checkout, { timeout: { block: timeoutMs } });
  const topLevel = await realpath((await git.revparse(["--show-toplevel"])).trim());
  const canonicalCheckout = await realpath(checkout);
  if (topLevel !== canonicalCheckout) {
    throw new Error("Git top-level does not match the authorized checkout.");
  }
  const rawGitDirectory = (await git.revparse(["--git-dir"])).trim();
  const gitDirectory = await realpath(path.isAbsolute(rawGitDirectory)
    ? rawGitDirectory
    : path.resolve(checkout, rawGitDirectory));
  const relativeGitDirectory = path.relative(canonicalCheckout, gitDirectory);
  if (relativeGitDirectory === ".." || relativeGitDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeGitDirectory)) {
    throw new Error("Git directory escapes the authorized checkout.");
  }
  for (const key of ["core.worktree", "core.fsmonitor", "core.sshCommand"] as const) {
    try {
      const configured = (await git.raw(["config", "--local", "--get", key])).trim();
      if (configured) throw new Error("Repository Git configuration is unsafe.");
    } catch (error) {
      if (error instanceof Error && error.message === "Repository Git configuration is unsafe.") throw error;
    }
  }
  try {
    const unsafeConfig = (await git.raw([
      "config", "--local", "--get-regexp",
      "^(filter\\..*\\.(clean|smudge|process)|submodule\\..*\\.update|core\\.hooksPath)$",
    ])).trim();
    if (unsafeConfig) throw new Error("Repository Git configuration is unsafe.");
  } catch (error) {
    if (error instanceof Error && error.message === "Repository Git configuration is unsafe.") throw error;
  }
  return checkout;
}

export function isTransientCloneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (classifyCloneFailure(message) !== "unknown_clone_failure" &&
      classifyCloneFailure(message) !== "clone_timeout") return false;
  const normalized = message.toLowerCase();
  return classifyCloneFailure(message) === "clone_timeout" ||
    isTransientTransportError(error) ||
    ["could not resolve host", "connection reset", "early eof", "rpc failed", "remote end hung up", "tls connection"].some(
      (fragment) => normalized.includes(fragment),
    );
}

export async function cloneRepo(
  owner: string,
  repo: string,
  options: {
    deadline?: Deadline;
    executeClone?: CloneExecutor;
    requestId?: string;
    jobId?: string;
    logger?: RetryLogger;
    metrics?: RetryMetrics;
    retryRuntime?: RetryRuntimeOptions;
    circuitBreaker?: CircuitBreaker;
    branch?: string | null;
    checkoutSnapshot?: SnapshotCheckoutExecutor;
  } = {},
): Promise<{
  clonePath: TrustedRepositoryCheckoutPath;
  alreadyExisted: boolean;
  commitSha: string;
  branch: string | null;
}> {
  const clonePath = repoClonePath(owner, repo);
  const deadline = options.deadline ?? createDeadline(env.REPOSITORY_CLONE_TIMEOUT_MS);
  const ownsDeadline = options.deadline === undefined;
  try {
    return await (options.circuitBreaker ?? runtimeDependencyCircuitBreakers.clone).execute(
      async () => {
        await ensureRepositoryStorageRoot();
        let alreadyExisted = false;
        if (existsSync(clonePath)) {
          await validateRepositoryCheckout(`${owner}/${repo}`, { mustExist: true });
          const entries = await readdir(clonePath);
          alreadyExisted = entries.length > 0;
          if (alreadyExisted) await validateGitWorkingDirectory(clonePath);
        }
        const repoUrl = `https://github.com/${owner}/${repo}.git`;
        try {
          deadline.throwIfExpired();
          const observability = createRetryObservability({
            category: "clone",
            operation: "repository_clone",
            logger: options.logger ?? logger,
            metrics: options.metrics ?? runtimeMetrics,
            fields: {
              requestId: options.requestId,
              jobId: options.jobId,
              repositoryId: `${owner}/${repo}`,
            },
          });
          if (!alreadyExisted) await retry(
            async (attempt) => {
              if (attempt > 1) await removeRepositoryCheckout(`${owner}/${repo}`);
              const attemptsRemaining = env.CLONE_MAX_RETRIES + 2 - attempt;
              const attemptTimeoutMs = Math.max(1, Math.floor(deadline.remainingMs() / attemptsRemaining));
              await (options.executeClone ?? defaultCloneExecutor)(repoUrl, clonePath, attemptTimeoutMs);
              await validateRepositoryCheckout(`${owner}/${repo}`, { mustExist: true });
            },
            {
              maxAttempts: env.CLONE_MAX_RETRIES + 1,
              baseDelayMs: env.CLONE_RETRY_BASE_MS,
              maxDelayMs: 5_000,
              deadline,
              isRetryable: isTransientCloneError,
              ...observability,
              ...options.retryRuntime,
            },
          );
          deadline.throwIfExpired();
          const snapshot = await (options.checkoutSnapshot ?? defaultSnapshotCheckoutExecutor)({
            clonePath,
            branch: options.branch ?? null,
            reusedClone: alreadyExisted,
            timeoutMs: Math.max(1, Math.floor(deadline.remainingMs())),
          });
          deadline.throwIfExpired();
          return {
            clonePath,
            alreadyExisted,
            commitSha: snapshot.commitSha,
            branch: snapshot.branch,
          };
        } catch (err) {
          try {
            await removeRepositoryCheckout(`${owner}/${repo}`);
          } catch {
            logger.error("repository_cleanup_rejected", {
              requestId: options.requestId,
              repositoryId: `${owner}/${repo}`,
              operation: "clone_failure_cleanup",
              reasonCode: "unsafe_cleanup_rejection",
            });
          }
          const message = err instanceof Error ? err.message : "unknown error";
          throw new Error(`Clone failed: ${message}`);
        }
      },
      {
        requestId: options.requestId,
        jobId: options.jobId,
        repositoryId: `${owner}/${repo}`,
        signal: deadline.signal,
      },
    );
  } finally {
    if (ownsDeadline) deadline.dispose();
  }
}
