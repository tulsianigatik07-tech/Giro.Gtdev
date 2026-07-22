export interface UserRepositoryQuotaUsage {
  ownerUserId: string;
  indexedRepositories: number;
  storageBytes: number;
  concurrentJobs: number;
}

export interface RepositoryQuotaStore {
  getUserUsage(ownerUserId: string): Promise<UserRepositoryQuotaUsage>;
}

export class MemoryRepositoryQuotaStore implements RepositoryQuotaStore {
  private readonly repositories = new Map<string, { ownerUserId: string; storageBytes: number }>();
  private readonly activeJobs = new Map<string, string>();

  recordRepository(repositoryId: string, ownerUserId: string, storageBytes: number): void {
    this.repositories.set(repositoryId, { ownerUserId, storageBytes });
  }

  removeRepository(repositoryId: string): void {
    this.repositories.delete(repositoryId);
  }

  recordActiveJob(jobId: string, ownerUserId: string): void {
    this.activeJobs.set(jobId, ownerUserId);
  }

  removeActiveJob(jobId: string): void {
    this.activeJobs.delete(jobId);
  }

  async getUserUsage(ownerUserId: string): Promise<UserRepositoryQuotaUsage> {
    const repositories = [...this.repositories.values()].filter((value) => value.ownerUserId === ownerUserId);
    return {
      ownerUserId,
      indexedRepositories: repositories.length,
      storageBytes: repositories.reduce((total, value) => total + value.storageBytes, 0),
      concurrentJobs: [...this.activeJobs.values()].filter((value) => value === ownerUserId).length,
    };
  }
}

interface RpcClient {
  rpc(name: string, parameters: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message?: string } | null;
  }>;
}

export class SupabaseRepositoryQuotaStore implements RepositoryQuotaStore {
  constructor(private readonly client: RpcClient) {}

  async getUserUsage(ownerUserId: string): Promise<UserRepositoryQuotaUsage> {
    const { data, error } = await this.client.rpc("get_user_repository_quota_usage", {
      input_owner_user_id: ownerUserId,
    });
    if (error) throw new Error(error.message ?? "Repository quota usage is unavailable.");
    const value = Array.isArray(data) ? data[0] : data;
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return {
      ownerUserId,
      indexedRepositories: Number(row.indexed_repositories ?? 0),
      storageBytes: Number(row.storage_bytes ?? 0),
      concurrentJobs: Number(row.concurrent_jobs ?? 0),
    };
  }
}
