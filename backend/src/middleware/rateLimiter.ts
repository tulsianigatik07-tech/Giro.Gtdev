import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { fail } from "../lib/response.js";
import { logger as defaultLogger, type StructuredLogger } from "../lib/logger.js";
import { getAuthenticatedUser } from "../services/auth/authContext.js";
import { MemoryRateLimitStore } from "../services/rateLimit/memoryRateLimitStore.js";
import type { RateLimitStore } from "../services/rateLimit/rateLimitStore.js";
import { resolveClientIp, validateTrustedProxyCidrs } from "./trustedProxy.js";

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
  burst?: number;
}

export type RateLimitPolicy = Readonly<Record<RateLimitBucket, RateLimitRule>>;

export interface CentralRateLimiterOptions {
  policy: RateLimitPolicy;
  classify?: (c: Context) => RateLimitBucket;
  keyGenerator?: RateLimitCallback;
  skip?: RateLimitSkipCallback;
  message?: string;
  now?: () => number;
  store?: RateLimitStore;
  trustedProxyCidrs?: readonly string[];
  onRejected?: (bucket: RateLimitBucket) => void;
  logger?: Pick<StructuredLogger, "warn">;
}

export interface RateLimiterOptions extends RateLimitRule {
  keyGenerator?: RateLimitCallback;
  skip?: RateLimitSkipCallback;
  message?: string;
  now?: () => number;
  store?: RateLimitStore;
  trustedProxyCidrs?: readonly string[];
  onRejected?: () => void;
  logger?: Pick<StructuredLogger, "warn">;
}

function requestIp(c: Context): string | undefined {
  const environment = c.env as {
    incoming?: { socket?: { remoteAddress?: string } };
    remoteAddress?: string;
  } | undefined;
  return environment?.incoming?.socket?.remoteAddress ?? environment?.remoteAddress;
}

export function defaultRateLimitKeyGenerator(c: Context): string {
  const user = getAuthenticatedUser(c);
  return user?.userId ? `user:${user.userId}` : `ip:${resolveClientIp({
    remoteAddress: requestIp(c),
    forwardedFor: c.req.header("x-forwarded-for"),
    trustedProxyCidrs: [],
  })}`;
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
    if (rule.burst !== undefined && (!Number.isSafeInteger(rule.burst) || rule.burst < 0)) {
      throw new TypeError(`${bucket}.burst must be a non-negative integer`);
    }
  }
}

function currentRequestId(c: Context): string | undefined {
  return (c as Context<{ Variables: { requestId: string } }>).get("requestId");
}

export function createRateLimitMiddleware(
  options: CentralRateLimiterOptions,
): MiddlewareHandler {
  validatePolicy(options.policy);
  const store = options.store ?? new MemoryRateLimitStore();
  const classify = options.classify ?? classifyRateLimitBucket;
  const trustedProxyCidrs = options.trustedProxyCidrs ?? [];
  validateTrustedProxyCidrs(trustedProxyCidrs);
  const keyGenerator = options.keyGenerator ?? ((c: Context) => {
    const user = getAuthenticatedUser(c);
    return user?.userId ? `user:${user.userId}` : `ip:${resolveClientIp({
      remoteAddress: requestIp(c),
      forwardedFor: c.req.header("x-forwarded-for"),
      trustedProxyCidrs,
    })}`;
  });
  const now = options.now ?? Date.now;
  const message = options.message ?? "Too many requests. Please try again later.";
  const log = options.logger ?? defaultLogger;

  return async (c, next) => {
    if (await options.skip?.(c)) {
      await next();
      return;
    }

    const timestamp = now();
    const bucket = classify(c);
    const rule = options.policy[bucket];
    const identity = await keyGenerator(c);
    const storageKey = createHash("sha256").update(`${bucket}\u0000${identity}`).digest("hex");
    const entry = await store.increment({ key: storageKey, windowMs: rule.windowMs, nowMs: timestamp });
    const effectiveLimit = rule.maxRequests + (rule.burst ?? 0);

    const remaining = Math.max(0, effectiveLimit - entry.count);
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1_000));
    c.header("X-RateLimit-Limit", String(effectiveLimit));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("Retry-After", String(retryAfter));

    if (entry.count > effectiveLimit) {
      options.onRejected?.(bucket);
      const user = getAuthenticatedUser(c);
      log.warn("rate_limit_exceeded", {
        requestId: currentRequestId(c),
        ...(user ? { userId: user.userId } : {}),
        rateLimitBucket: bucket,
        method: c.req.method,
        route: c.req.path,
        limit: effectiveLimit,
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
    burst: options.burst,
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
    store: options.store,
    trustedProxyCidrs: options.trustedProxyCidrs,
  });
}
