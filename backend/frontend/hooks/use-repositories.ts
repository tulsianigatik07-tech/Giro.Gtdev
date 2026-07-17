"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/features/auth/auth-context";
import { repositoriesApi } from "@/services/api/repositories";

export const repositoryKeys = {
  all: ["repositories"] as const,
  summary: (owner: string, repo: string) => ["repository", owner, repo, "summary"] as const,
};

export function useRepositories() {
  const { token } = useAuth();
  return useQuery({
    queryKey: repositoryKeys.all,
    queryFn: () => repositoriesApi.list(token as string),
    enabled: Boolean(token),
  });
}

export function useRepository(owner: string, repo: string) {
  const { token } = useAuth();
  const summary = useQuery({
    queryKey: repositoryKeys.summary(owner, repo),
    queryFn: () => repositoriesApi.summary(token as string, owner, repo),
    enabled: Boolean(token && owner && repo),
    retry: false,
  });
  return summary;
}

export function useConnectRepository() {
  const { token } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (repoUrl: string) => {
      const parsed = new URL(repoUrl);
      const [owner = "", repoWithSuffix = ""] = parsed.pathname.split("/").filter(Boolean);
      const repo = repoWithSuffix.replace(/\.git$/, "");
      const current = await repositoriesApi.list(token as string);
      const existing = current.repositories.find(
        (item) => item.owner === owner && item.repo === repo && item.status === "indexed",
      );
      if (existing) {
        return { repositoryId: `${owner}/${repo}`, status: "already_indexed" as const };
      }
      return repositoriesApi.connect(token as string, repoUrl);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: repositoryKeys.all }),
  });
}
