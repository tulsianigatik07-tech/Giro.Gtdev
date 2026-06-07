import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signAccessToken,
  verifyAccessToken,
  parseBearerToken,
} from "../services/auth/jwt.js";
import type { AuthTokenPayload } from "../services/auth/authTypes.js";

const PAYLOAD: AuthTokenPayload = { userId: "u_123", email: "a@example.com" };

test("1. sign + verify roundtrip", async () => {
  const token = await signAccessToken(PAYLOAD);
  const decoded = await verifyAccessToken(token);
  assert.deepEqual(decoded, PAYLOAD);
});

test("2. invalid token returns null", async () => {
  const result = await verifyAccessToken("not.a.valid.jwt");
  assert.equal(result, null);
});

test("3. malformed/garbage token returns null", async () => {
  assert.equal(await verifyAccessToken(""), null);
  assert.equal(await verifyAccessToken("garbage"), null);
});

test("4. parseBearerToken success (case-insensitive, trimmed)", () => {
  assert.equal(parseBearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(parseBearerToken("bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(parseBearerToken("  BEARER   xyz  "), "xyz");
});

test("5. parseBearerToken failure cases", () => {
  assert.equal(parseBearerToken(undefined), null);
  assert.equal(parseBearerToken(null), null);
  assert.equal(parseBearerToken(""), null);
  assert.equal(parseBearerToken("Bearer"), null); // no token
  assert.equal(parseBearerToken("Bearer   "), null); // empty token
  assert.equal(parseBearerToken("Basic abc"), null); // wrong scheme
  assert.equal(parseBearerToken("abc.def.ghi"), null); // no scheme
});

test("6. repeated verification is deterministic", async () => {
  const token = await signAccessToken(PAYLOAD);
  const a = await verifyAccessToken(token);
  const b = await verifyAccessToken(token);
  assert.deepEqual(a, b);
});

test("7. signAccessToken does not mutate payload", async () => {
  const input: AuthTokenPayload = { userId: "u_1", email: "x@y.z" };
  const snapshot = { ...input };
  await signAccessToken(input);
  assert.deepEqual(input, snapshot);
});

test("8. token missing required fields verifies to null", async () => {
  // A token signed with only a partial shape should fail payload validation.
  const { sign } = await import("hono/jwt");
  const { env } = await import("../config/env.js");
  const partial = await sign({ userId: "only-id" }, env.JWT_SECRET, "HS256");
  assert.equal(await verifyAccessToken(partial), null);
});
