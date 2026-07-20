import type { Context, MiddlewareHandler } from "hono";
import { fail } from "../lib/response.js";
import { logger as defaultLogger, type StructuredLogger } from "../lib/logger.js";
import { getAuthenticatedUser } from "../services/auth/authContext.js";

type RateLimitCallback = (c: Context) => string | Promise<string>;
type RateLimitSkipCallback = (c: Context) => boolean | Promise<boolean>;

export type RateLimitBucket =
  | "authentication"
  | "repositoryConnect"
  | "askGiro"
  | "retrievalSearch"
  | "indexingOperations"
  | "defaultApi";

export interface RateLimitRule {
  windowMs: number;
  maxRequests: number;
}

export type RateLimitPolicy = Readonly<Record<RateLimitBucket, RateLimitRule>>;

export interface CentralRateLimiterOptions {
  policy: RateLimitPolicy;
  classify?: (c: Context) => RateLimitBucket;
  keyGenerator?: RateLimitCallback;
  skip?: RateLimitSkipCallback;
  message?: string;
  now?: () => number;
  onRejected?: (bucket: RateLimitBucket) => void;
  logger?: Pick<StructuredLogger, "warn">;
}

export interface RateLimiterOptions extends RateLimitRule {
  keyGenerator?: RateLimitCallback;
  skip?: RateLimitSkipCallback;
  message?: string;
  now?: () => number;
  onRejected?: () => void;
  logger?: Pick<StructuredLogger, "warn">;
}

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

function firstForwardedAddress(value: string | undefined): string | undefined {
  return value?.split(",", 1)[0]?.trim() || undefined;
}

function requestIp(c: Context): string | undefined {
  const environment = c.env as {
    incoming?: { socket?: { remoteAddress?: string } };
    remoteAddress?: string;
  } | undefined;
  return environment?.incoming?.socket?.remoteAddress ?? environment?.remoteAddress;
}

function normalizedIp(c: Context): string {
  return firstForwardedAddress(c.req.header("x-forwarded-for")) ??
    c.req.header("cf-connecting-ip")?.trim() ??
    requestIp(c)?.trim() ??
    "localhost";
}

export function defaultRateLimitKeyGenerator(c: Context): string {
  const ipKey = `ip:${normalizedIp(c)}`;
  const user = getAuthenticatedUser(c);
  return user?.userId ? `${ipKey}|user:${user.userId}` : ipKey;
}

function routeMatches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function classifyRateLimitBucket(c: Context): RateLimitBucket {
  const path = c.req.path;
  if (
    routeMatches(path, "/auth") ||
    path === "/login" ||
    path === "/signup" ||
    path === "/token"
  ) return "authentication";
  if (path === "/repos/connect") return "repositoryConnect";
  if (path === "/chat" || /^\/sessions\/[^/]+\/ask\/?$/.test(path)) return "askGiro";
  if (
    routeMatches(path, "/retrieval") ||
    routeMatches(path, "/search") ||
    routeMatches(path, "/context") ||
    routeMatches(path, "/repos/search")
  ) return "retrievalSearch";
  if (
    routeMatches(path, "/indexing") ||
    /^\/repositories\/[^/]+\/indexing(?:\/|$)/.test(path)
  ) return "indexingOperations";
  return "defaultApi";
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function validatePolicy(policy: RateLimitPolicy): void {
  for (const [bucket, rule] of Object.entries(policy)) {
    assertPositiveInteger(rule.windowMs, `${bucket}.windowMs`);
    assertPositiveInteger(rule.maxRequests, `${bucket}.maxRequests`);
  }
}

function currentRequestId(c: Context): string | undefined {
  return (c as Context<{ Variables: { requestId: string } }>).get("requestId");
}

export function createRateLimitMiddleware(
  options: CentralRateLimiterOptions,
): MiddlewareHandler {
  validatePolicy(options.policy);
  const entries = new Map<string, RateLimitEntry>();
  const classify = options.classify ?? classifyRateLimitBucket;
  const keyGenerator = options.keyGenerator ?? defaultRateLimitKeyGenerator;
  const now = options.now ?? Date.now;
  const message = options.message ?? "Too many requests. Please try again later.";
  const log = options.logger ?? defaultLogger;
  let nextCleanupAt = 0;
  const longestWindowMs = Math.max(
    ...Object.values(options.policy).map((rule) => rule.windowMs),
  );

  return async (c, next) => {
    if (await options.skip?.(c)) {
      await next();
      return;
    }

    const timestamp = now();
    if (timestamp >= nextCleanupAt) {
      for (const [key, entry] of entries) {
        if (entry.resetAt <= timestamp) entries.delete(key);
      }
      nextCleanupAt = timestamp + longestWindowMs;
    }

    const bucket = classify(c);
    const rule = options.policy[bucket];
    const identity = await keyGenerator(c);
    const storageKey = `${bucket}\u0000${identity}`;
    const current = entries.get(storageKey);
    const entry = !current || current.resetAt <= timestamp
      ? { count: 1, resetAt: timestamp + rule.windowMs }
      : { count: current.count + 1, resetAt: current.resetAt };
    entries.set(storageKey, entry);

    const remaining = Math.max(0, rule.maxRequests - entry.count);
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1_000));
    c.header("X-RateLimit-Limit", String(rule.maxRequests));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("Retry-After", String(retryAfter));

    if (entry.count > rule.maxRequests) {
      options.onRejected?.(bucket);
      const user = getAuthenticatedUser(c);
      log.warn("rate_limit_exceeded", {
        requestId: currentRequestId(c),
        ...(user ? { userId: user.userId } : {}),
        rateLimitBucket: bucket,
        method: c.req.method,
        route: c.req.path,
        limit: rule.maxRequests,
        windowMs: rule.windowMs,
      });
      return fail(c, { code: "rate_limit_exceeded", message }, 429);
    }

    await next();
  };
}

export function rateLimiter(options: RateLimiterOptions): MiddlewareHandler {
  const rule = Object.freeze({
    windowMs: options.windowMs,
    maxRequests: options.maxRequests,
  });
  const policy = Object.freeze({
    authentication: rule,
    repositoryConnect: rule,
    askGiro: rule,
    retrievalSearch: rule,
    indexingOperations: rule,
    defaultApi: rule,
  });
  return createRateLimitMiddleware({
    policy,
    classify: () => "defaultApi",
    keyGenerator: options.keyGenerator,
    skip: options.skip,
    message: options.message,
    now: options.now,
    onRejected: options.onRejected,
    logger: options.logger,
  });
}
