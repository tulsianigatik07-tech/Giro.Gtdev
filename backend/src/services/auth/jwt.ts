import { randomUUID } from "node:crypto";
import { decode, sign, verify } from "hono/jwt";
import { env } from "../../config/env.js";
import type { AuthTokenPayload } from "./authTypes.js";

const ALG = "HS256" as const;
const BEARER_RE = /^Bearer$/i;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface JwtRuntimeConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly accessTokenTtlSeconds: number;
  readonly clockSkewSeconds: number;
  readonly activeKeyId: string;
  readonly activeSigningKey: string;
  readonly verificationKeys: Readonly<Record<string, string>>;
}

export interface JwtRuntimeOptions {
  readonly config?: JwtRuntimeConfig;
  readonly now?: () => number;
  readonly generateTokenId?: () => string;
}

export interface AccessTokenClaims extends AuthTokenPayload {
  readonly [claim: string]: unknown;
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
  readonly iss: string;
  readonly aud: string;
  readonly jti: string;
}

export const runtimeJwtConfig: JwtRuntimeConfig = Object.freeze({
  issuer: env.JWT_ISSUER,
  audience: env.JWT_AUDIENCE,
  accessTokenTtlSeconds: env.JWT_ACCESS_TOKEN_TTL_SECONDS,
  clockSkewSeconds: env.JWT_CLOCK_SKEW_SECONDS,
  activeKeyId: env.JWT_ACTIVE_KEY_ID,
  activeSigningKey: env.JWT_SECRET,
  verificationKeys: Object.freeze({
    ...env.JWT_VERIFICATION_KEYS,
    [env.JWT_ACTIVE_KEY_ID]: env.JWT_SECRET,
  }),
});

function symmetricJsonWebKey(
  secret: string,
  keyId: string,
): Parameters<typeof sign>[1] {
  return {
    kty: "oct",
    k: Buffer.from(secret, "utf8").toString("base64url"),
    alg: ALG,
    kid: keyId,
    key_ops: ["sign", "verify"],
    ext: false,
  };
}

function currentNumericDate(now: (() => number) | undefined): number {
  return Math.floor((now?.() ?? Date.now()) / 1_000);
}

function isRequiredString(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isNumericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasExpectedAudience(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.length > 0 &&
    value.every((audience) => typeof audience === "string") &&
    value.includes(expected);
}

function validatedClaims(
  value: Record<string, unknown>,
  config: JwtRuntimeConfig,
  now: number,
): AccessTokenClaims | null {
  if (
    !isRequiredString(value.sub) ||
    !isRequiredString(value.userId) ||
    value.sub !== value.userId ||
    !isRequiredString(value.email) ||
    !isRequiredString(value.jti, 128) ||
    !isNumericDate(value.iat) ||
    !isNumericDate(value.exp) ||
    value.iss !== config.issuer ||
    !hasExpectedAudience(value.aud, config.audience)
  ) return null;

  if (value.iat > now + config.clockSkewSeconds) return null;
  if (value.exp < now - config.clockSkewSeconds) return null;
  if (value.exp <= value.iat) return null;
  if (value.exp - value.iat > config.accessTokenTtlSeconds) return null;

  return Object.freeze({
    sub: value.sub,
    userId: value.userId,
    email: value.email,
    iat: value.iat,
    exp: value.exp,
    iss: config.issuer,
    aud: config.audience,
    jti: value.jti,
  });
}

export async function signAccessToken(
  payload: AuthTokenPayload,
  options: JwtRuntimeOptions = {},
): Promise<string> {
  const config = options.config ?? runtimeJwtConfig;
  const issuedAt = currentNumericDate(options.now);
  const claims: AccessTokenClaims = {
    sub: payload.userId,
    userId: payload.userId,
    email: payload.email,
    iat: issuedAt,
    exp: issuedAt + config.accessTokenTtlSeconds,
    iss: config.issuer,
    aud: config.audience,
    jti: options.generateTokenId?.() ?? randomUUID(),
  };
  return sign(
    claims,
    symmetricJsonWebKey(config.activeSigningKey, config.activeKeyId),
    ALG,
  );
}

export async function verifyAccessToken(
  token: string,
  options: JwtRuntimeOptions = {},
): Promise<AuthTokenPayload | null> {
  const config = options.config ?? runtimeJwtConfig;
  try {
    const decoded = decode(token);
    const keyId = decoded.header.kid;
    if (
      decoded.header.alg !== ALG ||
      !isRequiredString(keyId, 64) ||
      !KEY_ID_PATTERN.test(keyId)
    ) return null;
    const key = config.verificationKeys[keyId];
    if (!key) return null;

    const payload = await verify(
      token,
      symmetricJsonWebKey(key, keyId),
      { alg: ALG, exp: false, iat: false, nbf: false },
    );
    const claims = validatedClaims(
      payload as Record<string, unknown>,
      config,
      currentNumericDate(options.now),
    );
    return claims ? { userId: claims.userId, email: claims.email } : null;
  } catch {
    return null;
  }
}

export function parseBearerToken(
  header: string | undefined | null,
): string | null {
  if (typeof header !== "string") return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;

  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return null;

  const scheme = trimmed.slice(0, spaceIdx);
  if (!BEARER_RE.test(scheme)) return null;

  const token = trimmed.slice(spaceIdx + 1).trim();
  if (token.length === 0) return null;

  return token;
}
