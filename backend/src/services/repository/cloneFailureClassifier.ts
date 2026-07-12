import { createRepositoryError } from "../../lib/apiErrors.js";
import type { StandardApiError } from "../../lib/apiErrors.js";

type CloneFailureKind =
  | "repo_not_found"
  | "private_or_inaccessible"
  | "git_executable_failure"
  | "clone_timeout"
  | "destination_exists"
  | "unknown_clone_failure";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "unknown error";
}

function classifyCloneFailure(message: string): CloneFailureKind {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("repository not found") ||
    normalized.includes("not found")
  ) {
    return "repo_not_found";
  }

  if (
    normalized.includes("authentication failed") ||
    normalized.includes("could not read username") ||
    normalized.includes("permission denied") ||
    normalized.includes("access denied") ||
    normalized.includes("not authorized") ||
    normalized.includes("403")
  ) {
    return "private_or_inaccessible";
  }

  if (
    normalized.includes("spawn git enoent") ||
    normalized.includes("git: command not found") ||
    normalized.includes("cannot find git") ||
    normalized.includes("unable to find git")
  ) {
    return "git_executable_failure";
  }

  if (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("operation timed out") ||
    normalized.includes("deadline exceeded")
  ) {
    return "clone_timeout";
  }

  if (
    normalized.includes("destination path") &&
    normalized.includes("already exists")
  ) {
    return "destination_exists";
  }

  return "unknown_clone_failure";
}

export function buildRepositoryConnectFailureError(
  error: unknown,
  repository: string,
): StandardApiError {
  const message = errorMessage(error);
  const failureType = classifyCloneFailure(message);
  const details = { repository, failureType };

  if (failureType === "repo_not_found") {
    return createRepositoryError(
      "repo_not_found",
      "Repository not found.",
      { details, retryable: false },
    );
  }

  if (failureType === "clone_timeout") {
    return createRepositoryError(
      "clone_failed",
      "Repository clone timed out.",
      { details, retryable: true },
    );
  }

  if (failureType === "private_or_inaccessible") {
    return createRepositoryError(
      "clone_failed",
      "Repository is private or inaccessible.",
      { details, retryable: false },
    );
  }

  if (failureType === "git_executable_failure") {
    return createRepositoryError(
      "clone_failed",
      "Git executable failed while cloning the repository.",
      { details, retryable: false },
    );
  }

  if (failureType === "destination_exists") {
    return createRepositoryError(
      "clone_failed",
      "Repository clone destination already exists.",
      { details, retryable: false },
    );
  }

  return createRepositoryError(
    "clone_failed",
    "Repository clone failed.",
    { details },
  );
}
