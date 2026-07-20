import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../app.js";
import { clearAllSessions } from "../services/sessions/store.js";
import { clearRepositoryIndexRegistry } from "../services/repository/indexingService.js";
import { signAccessToken } from "../services/auth/jwt.js";
import { setRepositoryOwner } from "../services/repository/ownershipStore.js";
import { createProductionHealthCheck } from "../services/health/productionHealth.js";

type ApiResponse = {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  requestId: string;
};

// Valid bearer token for exercising protected routes in contract tests.
const AUTH = `Bearer ${await signAccessToken({ userId: "test-user", email: "test@example.com" })}`;
const HEALTHY_PRODUCTION_CHECK = createProductionHealthCheck({
  checkSupabase: () => undefined,
  checkIndexingWorker: () => undefined,
});

// Sessions may only target a repository owned by the user, so register the
// repo these contract tests create sessions for.
setRepositoryOwner("acme/demo", "test-user");

function asRecord(v: unknown): Record<string, unknown> {
  assert.ok(v && typeof v === "object", "expected object");
  return v as Record<string, unknown>;
}

async function call(method: string, path: string, body?: unknown) {
  const app = createApp({ productionHealthCheck: HEALTHY_PRODUCTION_CHECK });
  const res = await app.fetch(
    new Request("http://local" + path, {
      method,
      headers: { "content-type": "application/json", authorization: AUTH },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  const json = (await res.json()) as ApiResponse;
  return { status: res.status, json };
}

test("1. GET /health returns 200 with status field", async () => {
  const { status, json } = await call("GET", "/health");
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(asRecord(json.data).status, "healthy");
});

test("2. POST /sessions creates a session (201)", async () => {
  clearAllSessions();
  const { status, json } = await call("POST", "/sessions", { owner: "acme", repo: "demo" });
  assert.equal(status, 201);
  assert.equal(json.success, true);
  const data = asRecord(json.data);
  assert.equal(typeof data.id, "string");
  assert.ok((data.id as string).length > 0);
  assert.equal(data.owner, "acme");
  assert.equal(data.repo, "demo");
  assert.deepEqual(data.messages, []);
  assert.deepEqual(data.selectedContext, []);
});

test("3. GET /sessions returns array + count", async () => {
  clearAllSessions();
  await call("POST", "/sessions", { owner: "acme", repo: "demo" });
  const { json } = await call("GET", "/sessions");
  assert.equal(json.success, true);
  const data = asRecord(json.data);
  assert.ok(Array.isArray(data.sessions));
  assert.equal(typeof data.count, "number");
  assert.equal(data.count, (data.sessions as unknown[]).length);
});

test("4. GET unknown session returns 404 session_not_found", async () => {
  const { status, json } = await call("GET", "/sessions/" + randomUUID());
  assert.equal(status, 404);
  assert.equal(json.success, false);
  assert.equal(json.error?.code, "session_not_found");
});

test("5. POST message appends to session", async () => {
  clearAllSessions();
  const created = await call("POST", "/sessions", { owner: "acme", repo: "demo" });
  const id = asRecord(created.json.data).id as string;
  const before = (asRecord(created.json.data).messages as unknown[]).length;

  const { json } = await call("POST", `/sessions/${id}/messages`, { role: "user", content: "hi" });
  assert.equal(json.success, true);
  const messages = asRecord(json.data).messages as Array<Record<string, unknown>>;
  assert.ok(messages.length > before);
  const last = messages[messages.length - 1];
  assert.equal(last?.role, "user");
  assert.equal(last?.content, "hi");
});

test("6. POST message with invalid role returns 400 validation_failed", async () => {
  clearAllSessions();
  const created = await call("POST", "/sessions", { owner: "acme", repo: "demo" });
  const id = asRecord(created.json.data).id as string;
  const { status, json } = await call("POST", `/sessions/${id}/messages`, { role: "robot", content: "x" });
  assert.equal(status, 400);
  assert.equal(json.success, false);
  assert.equal(json.error?.code, "validation_failed");
});

test("7. DELETE session then GET returns 404", async () => {
  clearAllSessions();
  const created = await call("POST", "/sessions", { owner: "acme", repo: "demo" });
  const id = asRecord(created.json.data).id as string;

  const del = await call("DELETE", `/sessions/${id}`);
  assert.equal(del.json.success, true);

  const { status, json } = await call("GET", `/sessions/${id}`);
  assert.equal(status, 404);
  assert.equal(json.error?.code, "session_not_found");
});

test("8. GET /repos/indexed returns array + count", async () => {
  clearRepositoryIndexRegistry();
  const { json } = await call("GET", "/repos/indexed");
  assert.equal(json.success, true);
  const data = asRecord(json.data);
  assert.ok(Array.isArray(data.repositories));
  assert.equal(typeof data.count, "number");
  assert.equal(data.count, (data.repositories as unknown[]).length);
});
