"use client";

import { useQuery } from "@tanstack/react-query";
import { getRepositoryStatus } from "@/components/ui/status-badge";
import { useAuth } from "@/features/auth/auth-context";
import { useRepositories } from "@/hooks/use-repositories";
import { ApiClientError } from "@/services/api/client";
import { retrievalApi } from "@/services/api/retrieval";

export const MAX_REPOSITORY_SEARCH_QUERY_LENGTH = 500;

export type RepositorySearchState = "idle" | "loading" | "success" | "error";

export function useRepositorySearch(owner: string, repo: string, query: string) {
  const { token } = useAuth();
  const repositories = useRepositories();
  const normalizedQuery = query.trim();
  const repository = repositories.data?.repositories.find((item) => item.owner === owner && item.repo === repo);
  const repositoryStatus = getRepositoryStatus(repository?.status);
  const validationError = normalizedQuery.length > MAX_REPOSITORY_SEARCH_QUERY_LENGTH
    ? new ApiClientError({
        code: "validation_failed",
        message: `Search queries must contain at most ${MAX_REPOSITORY_SEARCH_QUERY_LENGTH} characters.`,
        status: 400,
        retryable: false,
      })
    : null;
  const canSearch = Boolean(
    token &&
    repositoryStatus.ready &&
    normalizedQuery.length > 0 &&
    !validationError,
  );
  const search = useQuery({
    queryKey: ["repository-search", owner, repo, repository?.lastIndexedAt, normalizedQuery],
    queryFn: () => retrievalApi.inspect(token as string, { query: normalizedQuery, owner, repo }),
    enabled: canSearch,
  });
  const failure = repositories.error ?? validationError ?? search.error;
  const state: RepositorySearchState = failure
    ? "error"
    : search.isFetching
      ? "loading"
      : canSearch && search.isSuccess
        ? "success"
        : "idle";

  return {
    state,
    idle: state === "idle",
    loading: state === "loading",
    success: state === "success",
    error: state === "error" ? failure : null,
    query: normalizedQuery,
    ready: repositoryStatus.ready,
    repositoryStatus,
    repository,
    data: search.data ?? null,
    checkingReadiness: repositories.isLoading,
    retry: repositories.isError ? repositories.refetch : validationError ? undefined : search.refetch,
  };
}
