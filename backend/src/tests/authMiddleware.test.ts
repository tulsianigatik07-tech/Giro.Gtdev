import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { signAccessToken } from "../services/auth/jwt.js";
import { getAuthenticatedUser } from "../services/auth/authContext.js";
import type { AuthTokenPayload } from "../services/auth/authTypes.js";

const PAYLOAD: AuthTokenPayload = { userId: "u_42", email: "dev@example.com" };

function buildApp() {
  const app = new Hono();
  app.use("/protected", authMiddleware());
  app.get("/protected", (c) => {
    const user = getAuthenticatedUser(c);
    return c.json({ ok: true, user });
  });
  return app;
}

async function call(app: Hono, headers?: Record<string, string>) {
  const res = await app.fetch(
    new Request("http://local/protected", { method: "GET", headers }),
  );
  const json = (await res.json()) as {
    ok?: boolean;
    user?: { userId: string; email: string };
    success?: boolean;
    error?: { code: string; message: string };
  };
  return { status: res.status, json };
}

test("1. rejects missing Authorization header (401 unauthorized)", async () => {
  const { status, json } = await call(buildApp());
  assert.equal(status, 401);
  assert.equal(json.success, false);
  assert.equal(json.error?.code, "unauthorized");
});

test("2. rejects malformed Authorization header (401 unauthorized)", async () => {
  const { status, json } = await call(buildApp(), { Authorization: "Basic xyz" });
  assert.equal(status, 401);
  assert.equal(json.error?.code, "unauthorized");
});

test("3. rejects invalid JWT (401 invalid_token)", async () => {
  const { status, json } = await call(buildApp(), { Authorization: "Bearer not.a.jwt" });
  assert.equal(status, 401);
  assert.equal(json.error?.code, "invalid_token");
});

test("4. accepts a valid JWT (200)", async () => {
  const token = await signAccessToken(PAYLOAD);
  const { status, json } = await call(buildApp(), { Authorization: `Bearer ${token}` });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
});

test("5. attaches authenticated user to context", async () => {
  const token = await signAccessToken(PAYLOAD);
  const { json } = await call(buildApp(), { Authorization: `Bearer ${token}` });
  assert.deepEqual(json.user, PAYLOAD);
});

test("6. empty Authorization header is rejected", async () => {
  const { status, json } = await call(buildApp(), { Authorization: "" });
  assert.equal(status, 401);
  assert.equal(json.error?.code, "unauthorized");
});
