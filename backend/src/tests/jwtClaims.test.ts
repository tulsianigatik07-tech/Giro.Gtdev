import assert from "node:assert/strict";
import test from "node:test";
import { decode, sign } from "hono/jwt";

import {
  signAccessToken,
  verifyAccessToken,
  type JwtRuntimeConfig,
} from "../services/auth/jwt.js";

const ACTIVE_SECRET = "active-test-secret-material-2026";
const PREVIOUS_SECRET = "previous-test-secret-material-2025";
const NOW_MS = 1_800_000_000_000;
const NOW = Math.floor(NOW_MS / 1_000);
const USER = { userId: "user-42", email: "user@example.com" };

const CONFIG: JwtRuntimeConfig = Object.freeze({
  issuer: "https://auth.giro.test",
  audience: "giro-api-test",
  accessTokenTtlSeconds: 900,
  clockSkewSeconds: 30,
  activeKeyId: "active-2026",
  activeSigningKey: ACTIVE_SECRET,
  verificationKeys: Object.freeze({
    "active-2026": ACTIVE_SECRET,
    "previous-2025": PREVIOUS_SECRET,
  }),
});

function jwk(secret: string, kid: string): Parameters<typeof sign>[1] {
  return {
    kty: "oct",
    k: Buffer.from(secret).toString("base64url"),
    alg: "HS256",
    kid,
    key_ops: ["sign", "verify"],
    ext: false,
  };
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: USER.userId,
    userId: USER.userId,
    email: USER.email,
    iat: NOW,
    exp: NOW + CONFIG.accessTokenTtlSeconds,
    iss: CONFIG.issuer,
    aud: CONFIG.audience,
    jti: "token-id-1",
    ...overrides,
  };
}

function signClaims(
  payload: Record<string, unknown>,
  keyId = CONFIG.activeKeyId,
  secret = ACTIVE_SECRET,
): Promise<string> {
  return sign(payload, jwk(secret, keyId), "HS256");
}

const verifyOptions = { config: CONFIG, now: () => NOW_MS } as const;

test("new access tokens contain every required claim and the active kid", async () => {
  const token = await signAccessToken(USER, {
    ...verifyOptions,
    generateTokenId: () => "generated-jti",
  });
  const decoded = decode(token);
  assert.equal(decoded.header.kid, CONFIG.activeKeyId);
  assert.equal(decoded.header.alg, "HS256");
  assert.deepEqual(decoded.payload, {
    sub: USER.userId,
    userId: USER.userId,
    email: USER.email,
    iat: NOW,
    exp: NOW + CONFIG.accessTokenTtlSeconds,
    iss: CONFIG.issuer,
    aud: CONFIG.audience,
    jti: "generated-jti",
  });
});

test("valid issuer- and audience-bound token is accepted", async () => {
  const token = await signAccessToken(USER, verifyOptions);
  assert.deepEqual(await verifyAccessToken(token, verifyOptions), USER);
});

test("expired token is rejected", async () => {
  const token = await signClaims(claims({
    iat: NOW - 1_000,
    exp: NOW - CONFIG.clockSkewSeconds,
  }));
  assert.equal(await verifyAccessToken(token, verifyOptions), null);
});

test("future-issued token beyond clock skew is rejected", async () => {
  const iat = NOW + CONFIG.clockSkewSeconds + 1;
  const token = await signClaims(claims({ iat, exp: iat + 600 }));
  assert.equal(await verifyAccessToken(token, verifyOptions), null);
});

test("wrong issuer and wrong audience are rejected", async () => {
  const wrongIssuer = await signClaims(claims({ iss: "https://other.test" }));
  const wrongAudience = await signClaims(claims({ aud: "another-api" }));
  assert.equal(await verifyAccessToken(wrongIssuer, verifyOptions), null);
  assert.equal(await verifyAccessToken(wrongAudience, verifyOptions), null);
});

test("missing required claims are rejected", async () => {
  for (const missing of ["exp", "iat", "iss", "aud", "jti", "sub", "userId", "email"] as const) {
    const payload = claims();
    delete payload[missing];
    assert.equal(await verifyAccessToken(await signClaims(payload), verifyOptions), null);
  }
});

test("subject and user identity must match", async () => {
  const token = await signClaims(claims({ sub: "different-user" }));
  assert.equal(await verifyAccessToken(token, verifyOptions), null);
});

test("malformed numeric dates are rejected", async () => {
  for (const malformed of [
    { iat: "not-a-date" },
    { exp: "1800000900" },
    { iat: Number.NaN },
    { exp: 1.5 },
  ]) {
    assert.equal(
      await verifyAccessToken(await signClaims(claims(malformed)), verifyOptions),
      null,
    );
  }
});

test("previous verification key remains accepted during rotation", async () => {
  const token = await signClaims(claims(), "previous-2025", PREVIOUS_SECRET);
  assert.deepEqual(await verifyAccessToken(token, verifyOptions), USER);
});

test("unknown kid is rejected without trying active key material", async () => {
  const token = await signClaims(claims(), "unknown-key", ACTIVE_SECRET);
  assert.equal(await verifyAccessToken(token, verifyOptions), null);
});

test("clock skew accepts temporal drift only within the configured bound", async () => {
  const futureWithinSkew = NOW + CONFIG.clockSkewSeconds;
  const futureToken = await signClaims(claims({
    iat: futureWithinSkew,
    exp: futureWithinSkew + 600,
  }));
  const recentlyExpired = await signClaims(claims({
    iat: NOW - 900,
    exp: NOW - CONFIG.clockSkewSeconds,
  }));
  assert.deepEqual(await verifyAccessToken(futureToken, verifyOptions), USER);
  assert.deepEqual(await verifyAccessToken(recentlyExpired, verifyOptions), USER);
});

test("verification failures never expose signing or verification key material", async () => {
  const token = await signClaims(claims(), "unknown-key", ACTIVE_SECRET);
  const result = await verifyAccessToken(token, verifyOptions);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(ACTIVE_SECRET), false);
  assert.equal(serialized.includes(PREVIOUS_SECRET), false);
});
