import type { Context, MiddlewareHandler } from "hono";
import { fail } from "../lib/response.js";
import { getAuthenticatedUser } from "../services/auth/authContext.js";

type RateLimitCallback = (c: Context) => string | Promise<string>;
type RateLimitSkipCallback = (c: Context) => boolean | Promise<boolean>;

export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: RateLimitCallback;
  skip?: RateLimitSkipCallback;
  message?: string;
  now?: () => number;
  onRejected?: () => void;
}

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const LOCALHOST_KEY = "ip:localhost";

function firstForwardedAddress(value: string | undefined): string | undefined {
  return value
    ?.split(",", 1)[0]
    ?.trim() || undefined;
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
  if (user?.userId) return `user:${user.userId}`;

  const forwarded = firstForwardedAddress(c.req.header("x-forwarded-for"));
  if (forwarded) return `ip:${forwarded}`;

  const cloudflare = c.req.header("cf-connecting-ip")?.trim();
  if (cloudflare) return `ip:${cloudflare}`;

  const ip = requestIp(c)?.trim();
  return ip ? `ip:${ip}` : LOCALHOST_KEY;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

export function rateLimiter(options: RateLimiterOptions): MiddlewareHandler {
  assertPositiveInteger(options.windowMs, "windowMs");
  assertPositiveInteger(options.maxRequests, "maxRequests");

  const entries = new Map<string, RateLimitEntry>();
  const keyGenerator = options.keyGenerator ?? defaultRateLimitKeyGenerator;
  const now = options.now ?? Date.now;
  const message = options.message ?? "Too many requests. Please try again later.";
  let nextCleanupAt = 0;

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
      nextCleanupAt = timestamp + options.windowMs;
    }

    const key = await keyGenerator(c);
    const current = entries.get(key);
    const entry = !current || current.resetAt <= timestamp
      ? { count: 1, resetAt: timestamp + options.windowMs }
      : { count: current.count + 1, resetAt: current.resetAt };
    entries.set(key, entry);

    const remaining = Math.max(0, options.maxRequests - entry.count);
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1_000));
    c.header("X-RateLimit-Limit", String(options.maxRequests));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("Retry-After", String(retryAfter));

    if (entry.count > options.maxRequests) {
      options.onRejected?.();
      return fail(c, { code: "rate_limit_exceeded", message }, 429);
    }

    await next();
  };
}
