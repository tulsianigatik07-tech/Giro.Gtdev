import type {
  RateLimitIncrementInput,
  RateLimitIncrementResult,
  RateLimitStore,
} from "./rateLimitStore.js";

interface SupabaseRpcClient {
  rpc(name: string, parameters?: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message?: string } | null;
  }>;
}

function firstRow(data: unknown): Record<string, unknown> | null {
  const value = Array.isArray(data) ? data[0] : data;
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function assertRpc(error: { message?: string } | null): void {
  if (error) throw new Error(error.message ?? "Distributed rate-limit operation failed.");
}

export class SupabaseRateLimitStore implements RateLimitStore {
  constructor(private readonly client: SupabaseRpcClient) {}

  async increment(input: RateLimitIncrementInput): Promise<RateLimitIncrementResult> {
    const { data, error } = await this.client.rpc("increment_rate_limit", {
      input_bucket_key: input.key,
      input_window_ms: input.windowMs,
    });
    assertRpc(error);
    const row = firstRow(data);
    const count = Number(row?.request_count);
    const resetAt = Date.parse(String(row?.reset_at ?? ""));
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(resetAt)) {
      throw new Error("Distributed rate-limit operation returned an invalid result.");
    }
    return { count, resetAt };
  }

  async verify(): Promise<void> {
    const { data, error } = await this.client.rpc("verify_rate_limit_backend");
    assertRpc(error);
    if (data !== true) throw new Error("Distributed rate-limit backend verification failed.");
  }
}
