export interface RateLimitIncrementInput {
  key: string;
  windowMs: number;
  nowMs?: number;
}

export interface RateLimitIncrementResult {
  count: number;
  resetAt: number;
}

export interface RateLimitStore {
  increment(input: RateLimitIncrementInput): Promise<RateLimitIncrementResult>;
  verify(): Promise<void>;
  clear?(): Promise<void>;
}
