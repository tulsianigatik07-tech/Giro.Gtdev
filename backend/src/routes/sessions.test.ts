// Session route ownership coverage.
//
// NOTE ON MOCKING: the prompt asks to mock ../services/sessions/questionService.js
// via node:test mock APIs. node:test's `mock.module` is NOT available under the
// `tsx --test` runner used by this project (verified: "mock.module is not a
// function"), and the route imports `answerSessionQuestion` as a static named
// binding (un-mockable without refactoring the route, which is forbidden).
// Instead, the `ask` tests run against the service's offline-degraded path:
// the target repo is never cloned and embeddings are mock, so no real
// retrieval/AI/network executes. Ownership/auth checks (the focus of this
// suite) run before `answerSessionQuestion` and are asserted directly.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import { clearAllSessions } from "../services/sessions/store.js";
import {
  setRepositoryOwner,
  clearRepositoryOwners,
} from "../services/repository/ownershipStore.js";
import { requireSessionAccess } from "../services/sessions/sessionOwnershipGuard.js";
import {
  clearRepositoryIndexRegistry,
  setRepositoryIndexed,
} from "../services/repository/indexingService.js";

const USER_A = { userId: "user-a", email: "a@example.com" };
const USER_B = { userId: "user-b", email: "b@example.com" };

const TOKENS: Record<string, string> = {
  [USER_A.userId]: await signAccessToken(USER_A),
  [USER_B.userId]: await signAccessToken(USER_B),
};

type ApiResponse = {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
};

function authHeader(userId: string): string {
  return `Bearer ${TOKENS[userId]}`;
}

function asRecord(v: unknown): Record<string, unknown> {
  assert.ok(v && typeof v === "object", "expected object");
  return v as Record<string, unknown>;
}

async function call(
  method: string,
  path: string,
  authorization?: string,
  body?: unknown,
): Promise<{ status: number; json: ApiResponse }> {
  const app = createApp();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;
  const res = await app.request(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as ApiResponse;
  return { status: res.status, json };
}

async function createSession(
  authorization: string,
  body: { owner: string; repo: string; title?: string },
): Promise<{ status: number; json: ApiResponse }> {
  return call("POST", "/sessions", authorization, body);
}

beforeEach(() => {
  clearAllSessions();
  clearRepositoryOwners();
  clearRepositoryIndexRegistry();
});

// --- Session Creation ---
test("1. authenticated user creates session -> 201", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const { status } = await createSession(authHeader(USER_A.userId), { owner: "acme", repo: "demo" });
  assert.equal(status, 201);
});

test("2. created session stores the userId from the JWT", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const { json } = await createSession(authHeader(USER_A.userId), { owner: "acme", repo: "demo" });
  assert.equal(asRecord(json.data).userId, USER_A.userId);
});

// --- Session Listing ---
test("3. listing is scoped to the authenticated user", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  setRepositoryOwner("bravo/svc", USER_B.userId);

  await createSession(authHeader(USER_A.userId), { owner: "acme", repo: "demo" });
  await createSession(authHeader(USER_A.userId), { owner: "acme", repo: "demo" });
  await createSession(authHeader(USER_B.userId), { owner: "bravo", repo: "svc" });

  const listA = await call("GET", "/sessions", authHeader(USER_A.userId));
  assert.equal(asRecord(listA.json.data).count, 2);

  const listB = await call("GET", "/sessions", authHeader(USER_B.userId));
  assert.equal(asRecord(listB.json.data).count, 1);
});

// --- Session Read ---
test("4. owner reads own session -> 200", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const created = await createSession(authHeader(USER_A.userId), { owner: "acme", repo: "demo" });
  const id = asRecord(created.json.data).id as string;

  const { status } = await call("GET", `/sessions/${id}`, authHeader(USER_A.userId));
  assert.equal(status, 200);
});

test("5. different user reading a session -> 403 session_not_owned", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const created = await createSession(authHeader(USER_A.userId), { owner: "acme", repo: "demo" });
  const id = asRecord(created.json.data).id as string;

  const { status, json } = await call("GET", `/sessions/${id}`, authHeader(USER_B.userId));
  assert.equal(status, 403);
  assert.equal(json.error?.code, "session_not_owned");
});

test("6. reading a missing session -> 404 session_not_found", async () => {
  const { status, json } = await call("GET", "/sessions/does-not-exist", authHeader(USER_A.userId));
  assert.equal(status, 404);
  assert.equal(json.error?.code, "session_not_found");
});

// --- Session Messages ---
test("7. owner can add a message", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const created = await createSession(authHeader(USER_A.userId), { owner: "acme", repo: "demo" });
  const id = asRecord(created.json.data).id as string;

  const { status } = await call("POST", `/sessions/${id}/messages`, authHeader(USER_A.userId), {
    role: "user",
    content: "hello",
  });
  assert.equal(status, 200);
});

test("8. different user adding a message -> 403 session_not_owned", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const created = await createSession(authHeader(USER_A.userId), { owner: "acme", repo: "demo" });
  const id = asRecord(created.json.data).id as string;

  const { status, json } = await call("POST", `/sessions/${id}/messages`, authHeader(USER_B.userId), {
    role: "user",
    content: "intrusion",
  });
  assert.equal(status, 403);
  assert.equal(json.error?.code, "session_not_owned");
});

// --- Session Ask ---
test("9. owner can ask a question (reaches handler past ownership)", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  setRepositoryIndexed("acme", "demo", {
    chunkCount: 1,
    fileCount: 1,
    symbolCount: 0,
    graphNodeCount: 0,
    graphEdgeCount: 0,
    summaryAvailable: false,
  });
  const created = await createSession(authHeader(USER_A.userId), { owner: "acme", repo: "demo" });
  const id = asRecord(created.json.data).id as string;

  const { status } = await call("POST", `/sessions/${id}/ask`, authHeader(USER_A.userId), {
    question: "explain the architecture",
  });
  // Passed auth + session ownership + repo ownership; offline-degraded answer.
  assert.notEqual(status, 401);
  assert.notEqual(status, 403);
  assert.notEqual(status, 404);
});

test("9b. indexed state is required before retrieval", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const created = await createSession(authHeader(USER_A.userId), { owner: "acme", repo: "demo" });
  const id = asRecord(created.json.data).id as string;

  const { status, json } = await call("POST", `/sessions/${id}/ask`, authHeader(USER_A.userId), {
    question: "explain",
  });
  assert.equal(status, 409);
  assert.equal(json.error?.code, "repository_not_ready");
});

test("9c. legacy unscoped chat endpoint is deprecated", async () => {
  const { status, json } = await call("POST", "/chat", authHeader(USER_A.userId), {
    query: "explain",
  });
  assert.equal(status, 410);
  assert.equal(json.error?.code, "endpoint_deprecated");
});

test("10. different user asking -> 403 session_not_owned", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const created = await createSession(authHeader(USER_A.userId), { owner: "acme", repo: "demo" });
  const id = asRecord(created.json.data).id as string;

  const { status, json } = await call("POST", `/sessions/${id}/ask`, authHeader(USER_B.userId), {
    question: "explain",
  });
  assert.equal(status, 403);
  assert.equal(json.error?.code, "session_not_owned");
});

// --- Session Delete ---
test("11. owner can delete own session", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const created = await createSession(authHeader(USER_A.userId), { owner: "acme", repo: "demo" });
  const id = asRecord(created.json.data).id as string;

  const { status, json } = await call("DELETE", `/sessions/${id}`, authHeader(USER_A.userId));
  assert.equal(status, 200);
  assert.equal(asRecord(json.data).deleted, true);
});

test("12. different user deleting a session -> 403 session_not_owned", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const created = await createSession(authHeader(USER_A.userId), { owner: "acme", repo: "demo" });
  const id = asRecord(created.json.data).id as string;

  const { status, json } = await call("DELETE", `/sessions/${id}`, authHeader(USER_B.userId));
  assert.equal(status, 403);
  assert.equal(json.error?.code, "session_not_owned");
});

test("13. deleted session returns 404 when read again", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const created = await createSession(authHeader(USER_A.userId), { owner: "acme", repo: "demo" });
  const id = asRecord(created.json.data).id as string;

  await call("DELETE", `/sessions/${id}`, authHeader(USER_A.userId));
  const { status, json } = await call("GET", `/sessions/${id}`, authHeader(USER_A.userId));
  assert.equal(status, 404);
  assert.equal(json.error?.code, "session_not_found");
});

// --- Session Ownership Guard (direct unit) ---
test("14. guard: owned session -> ok:true", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const created = await createSession(authHeader(USER_A.userId), { owner: "acme", repo: "demo" });
  const id = asRecord(created.json.data).id as string;

  const result = requireSessionAccess({ sessionId: id, userId: USER_A.userId });
  assert.equal(result.ok, true);
});

test("15. guard: wrong owner -> 403 session_not_owned", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const created = await createSession(authHeader(USER_A.userId), { owner: "acme", repo: "demo" });
  const id = asRecord(created.json.data).id as string;

  const result = requireSessionAccess({ sessionId: id, userId: USER_B.userId });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 403);
    assert.equal(result.code, "session_not_owned");
  }
});

test("16. guard: missing session -> 404 session_not_found", () => {
  const result = requireSessionAccess({ sessionId: "nope", userId: USER_A.userId });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 404);
    assert.equal(result.code, "session_not_found");
  }
});

// --- Authentication Interaction ---
test("17. missing Authorization header -> 401 unauthorized", async () => {
  const { status, json } = await call("GET", "/sessions");
  assert.equal(status, 401);
  assert.equal(json.error?.code, "unauthorized");
});

test("18. invalid token -> 401 invalid_token", async () => {
  const { status, json } = await call("GET", "/sessions", "Bearer not-a-real-jwt");
  assert.equal(status, 401);
  assert.equal(json.error?.code, "invalid_token");
});

test("19. valid JWT reaches ownership checks (404, not 401)", async () => {
  const { status, json } = await call("GET", "/sessions/missing-id", authHeader(USER_A.userId));
  assert.equal(status, 404);
  assert.equal(json.error?.code, "session_not_found");
});
