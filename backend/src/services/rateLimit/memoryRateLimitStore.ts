import type {
  RateLimitIncrementInput,
  RateLimitIncrementResult,
  RateLimitStore,
} from "./rateLimitStore.js";

type Entry = { count: number; resetAt: number; windowMs: number };

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly entries = new Map<string, Entry>();

  async increment(input: RateLimitIncrementInput): Promise<RateLimitIncrementResult> {
    const timestamp = input.nowMs ?? Date.now();
    const current = this.entries.get(input.key);
    const next = !current || current.resetAt <= timestamp || current.windowMs !== input.windowMs
      ? { count: 1, resetAt: timestamp + input.windowMs, windowMs: input.windowMs }
      : { ...current, count: current.count + 1 };
    this.entries.set(input.key, next);
    return { count: next.count, resetAt: next.resetAt };
  }

  async verify(): Promise<void> {}

  async clear(): Promise<void> {
    this.entries.clear();
  }
}
