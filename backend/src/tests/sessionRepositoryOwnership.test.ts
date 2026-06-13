import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { ok } from "../lib/response.js";
import { setAuthenticatedUser } from "../services/auth/authContext.js";
import { requireSessionRepositoryOwnership } from "../middleware/requireSessionRepositoryOwnership.js";
import { createNewSession, getSessionById } from "../services/sessions/sessionService.js";
import { clearAllSessions } from "../services/sessions/store.js";
import {
  setRepositoryOwner,
  clearRepositoryOwners,
} from "../services/repository/ownershipStore.js";
import type { AuthenticatedUser } from "../services/auth/authTypes.js";

const USER_A: AuthenticatedUser = { userId: "user-a", email: "a@example.com" };
const USER_B: AuthenticatedUser = { userId: "user-b", email: "b@example.com" };

type ApiResponse = {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
};

// Throwaway app: optionally injects a user, then runs the middleware under test,
// then a final handler that proves downstream was reached.
function buildApp(user?: AuthenticatedUser) {
  const app = new Hono();
  app.get(
    "/s/:id",
    async (c, next) => {
      if (user) setAuthenticatedUser(c, user);
      await next();
    },
    requireSessionRepositoryOwnership(),
    (c) => ok(c, { reached: true }),
  );
  return app;
}

async function call(
  user: AuthenticatedUser | undefined,
  id: string,
): Promise<{ status: number; json: ApiResponse }> {
  const app = buildApp(user);
  const res = await app.fetch(new Request(`http://local/s/${id}`));
  const json = (await res.json().catch(() => ({}))) as ApiResponse;
  return { status: res.status, json };
}

function seedSession(user: AuthenticatedUser, owner: string, repo: string): string {
  return createNewSession({ userId: user.userId, owner, repo }).id;
}

beforeEach(() => {
  clearAllSessions();
  clearRepositoryOwners();
});

test("1. owner of repository passes and reaches downstream handler", async () => {
  const id = seedSession(USER_A, "acme", "demo");
  setRepositoryOwner("acme/demo", USER_A.userId);

  const { status, json } = await call(USER_A, id);
  assert.equal(status, 200);
  assert.deepEqual(json.data, { reached: true });
});

test("2. unknown session id returns 404 session_not_found", async () => {
  const { status, json } = await call(USER_A, "no-such-session");
  assert.equal(status, 404);
  assert.equal(json.error?.code, "session_not_found");
});

test("3. missing authenticated user returns 401 unauthorized", async () => {
  const id = seedSession(USER_A, "acme", "demo");
  setRepositoryOwner("acme/demo", USER_A.userId);

  const { status, json } = await call(undefined, id);
  assert.equal(status, 401);
  assert.equal(json.error?.code, "unauthorized");
});

test("4. different user returns 403 repo_not_owned", async () => {
  const id = seedSession(USER_A, "acme", "demo");
  setRepositoryOwner("acme/demo", USER_A.userId);

  const { status, json } = await call(USER_B, id);
  assert.equal(status, 403);
  assert.equal(json.error?.code, "repo_not_owned");
});

test("5. repository with no ownership record returns 404 repo_not_connected", async () => {
  const id = seedSession(USER_A, "acme", "demo");
  // intentionally NOT calling setRepositoryOwner

  const { status, json } = await call(USER_A, id);
  assert.equal(status, 404);
  assert.equal(json.error?.code, "repo_not_connected");
});

test("6. non-existent session id returns 404 session_not_found", async () => {
  const { status, json } = await call(USER_A, "definitely-missing");
  assert.equal(status, 404);
  assert.equal(json.error?.code, "session_not_found");
});

test("7. repeated identical requests return identical status/code", async () => {
  const id = seedSession(USER_A, "acme", "demo");
  setRepositoryOwner("acme/demo", USER_B.userId); // owned by B

  const first = await call(USER_A, id);
  const second = await call(USER_A, id);
  assert.equal(first.status, second.status);
  assert.equal(first.json.error?.code, second.json.error?.code);
  assert.equal(first.status, 403);
  assert.equal(first.json.error?.code, "repo_not_owned");
});

test("8. session state is unchanged before and after middleware execution", async () => {
  const id = seedSession(USER_A, "acme", "demo");
  setRepositoryOwner("acme/demo", USER_A.userId);

  const before = JSON.parse(JSON.stringify(getSessionById(id)));
  await call(USER_A, id);
  const after = JSON.parse(JSON.stringify(getSessionById(id)));
  assert.deepEqual(after, before);
});
