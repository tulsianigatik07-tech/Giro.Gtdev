import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import { createProductionHealthCheck } from "../services/health/productionHealth.js";

const VALID = `Bearer ${await signAccessToken({ userId: "u1", email: "u1@example.com" })}`;
const HEALTHY_PRODUCTION_CHECK = createProductionHealthCheck({
  checkSupabase: () => undefined,
  checkIndexingWorker: () => undefined,
});

type ApiResponse = {
  success: boolean;
  error?: { code: string; message: string };
};

async function call(path: string, headers?: Record<string, string>, method = "GET") {
  const app = createApp({ productionHealthCheck: HEALTHY_PRODUCTION_CHECK });
  const res = await app.fetch(
    new Request("http://local" + path, {
      method,
      headers: { "content-type": "application/json", ...(headers ?? {}) },
    }),
  );
  const json = (await res.json().catch(() => ({}))) as ApiResponse;
  return { status: res.status, json };
}

// One representative protected path per group that exists.
const PROTECTED_GETS = [
  "/repos/indexed",
  "/sessions",
];

test("1. protected route returns 401 without Authorization header", async () => {
  for (const path of PROTECTED_GETS) {
    const { status, json } = await call(path);
    assert.equal(status, 401, `${path} should be 401`);
    assert.equal(json.error?.code, "unauthorized");
  }
});

test("2. protected route returns 401 with malformed Authorization header", async () => {
  const { status, json } = await call("/sessions", { authorization: "Basic xyz" });
  assert.equal(status, 401);
  assert.equal(json.error?.code, "unauthorized");
});

test("3. protected route returns 401 with invalid/tampered JWT", async () => {
  const { status, json } = await call("/sessions", { authorization: "Bearer not.a.real.jwt" });
  assert.equal(status, 401);
  assert.equal(json.error?.code, "invalid_token");
});

test("4. valid JWT passes auth and reaches the handler (not a 401)", async () => {
  for (const path of PROTECTED_GETS) {
    const { status } = await call(path, { authorization: VALID });
    assert.notEqual(status, 401, `${path} should pass auth with a valid token`);
  }
});

test("5. POST to a protected group reaches the validation layer with valid JWT", async () => {
  // No body -> handler-level validation_failed (400), proving auth was passed
  // and the real handler executed (not a 401 auth failure).
  const { status, json } = await call("/sessions", { authorization: VALID }, "POST");
  assert.notEqual(status, 401);
  assert.equal(json.success, false);
  assert.equal(json.error?.code, "validation_failed");
});

test("6. health route remains accessible without auth", async () => {
  const { status } = await call("/health");
  assert.equal(status, 200);
});

test("7. root route remains accessible without auth", async () => {
  const { status } = await call("/");
  assert.equal(status, 200);
});

test("8. context route group is protected (401 without token)", async () => {
  const { status, json } = await call("/context/assemble", undefined, "POST");
  assert.equal(status, 401);
  assert.equal(json.error?.code, "unauthorized");
});

test("9. retrieval route group is protected (401 without token)", async () => {
  const { status, json } = await call("/retrieval/hybrid", undefined, "POST");
  assert.equal(status, 401);
  assert.equal(json.error?.code, "unauthorized");
});

test("10. tools route group is protected (401 without token)", async () => {
  const { status, json } = await call("/tools/read-file", undefined, "POST");
  assert.equal(status, 401);
  assert.equal(json.error?.code, "unauthorized");
});
