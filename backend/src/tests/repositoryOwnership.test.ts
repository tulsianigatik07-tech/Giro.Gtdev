import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import {
  setRepositoryOwner,
  getRepositoryOwner,
  clearRepositoryOwners,
} from "../services/repository/ownershipStore.js";
import { requireRepositoryAccess } from "../services/repository/ownershipGuard.js";

const USER_A = { userId: "user-a", email: "a@example.com" };
const USER_B = { userId: "user-b", email: "b@example.com" };

type ApiResponse = { success: boolean; error?: { code: string; message: string } };

async function bearer(user: { userId: string; email: string }): Promise<string> {
  return `Bearer ${await signAccessToken(user)}`;
}

async function call(path: string, authorization?: string, method = "GET") {
  const app = createApp();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;
  const res = await app.fetch(new Request("http://local" + path, { method, headers }));
  const json = (await res.json().catch(() => ({}))) as ApiResponse;
  return { status: res.status, json };
}

beforeEach(() => {
  clearRepositoryOwners();
});

// --- ownershipStore / ownershipGuard unit behavior ---

test("1. ownership assignment: store records owner", () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  assert.equal(getRepositoryOwner("acme/demo"), USER_A.userId);
});

test("1b. ownership assignment replaces existing owner", () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  setRepositoryOwner("acme/demo", USER_B.userId);

  assert.equal(getRepositoryOwner("acme/demo"), USER_B.userId);
});

test("1c. ownership reset clears repository owners", () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  clearRepositoryOwners();

  assert.equal(getRepositoryOwner("acme/demo"), undefined);
});

test("2. guard: unknown ownership -> 404 repo_not_connected", () => {
  const r = requireRepositoryAccess({ repoId: "ghost/missing", userId: USER_A.userId });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 404);
    assert.equal(r.code, "repo_not_connected");
  }
});

test("3. guard: wrong owner -> 403 repo_not_owned", () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const r = requireRepositoryAccess({ repoId: "acme/demo", userId: USER_B.userId });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 403);
    assert.equal(r.code, "repo_not_owned");
  }
});

test("4. guard: correct owner -> ok", () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const r = requireRepositoryAccess({ repoId: "acme/demo", userId: USER_A.userId });
  assert.equal(r.ok, true);
});

test("4b. repeated ownership checks are deterministic", () => {
  setRepositoryOwner("acme/demo", USER_A.userId);

  const firstAllowed = requireRepositoryAccess({
    repoId: "acme/demo",
    userId: USER_A.userId,
  });
  const secondAllowed = requireRepositoryAccess({
    repoId: "acme/demo",
    userId: USER_A.userId,
  });
  const firstDenied = requireRepositoryAccess({
    repoId: "acme/demo",
    userId: USER_B.userId,
  });
  const secondDenied = requireRepositoryAccess({
    repoId: "acme/demo",
    userId: USER_B.userId,
  });

  assert.deepEqual(secondAllowed, firstAllowed);
  assert.deepEqual(secondDenied, firstDenied);
});

// --- route-level enforcement (no cloning: guard runs before network work) ---

test("5. authorized access: owner reaches handler (not 403/404 from ownership)", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const { status, json } = await call("/repos/dependencies/acme/demo", await bearer(USER_A));
  // Owner passes ownership; downstream may 404 "Repository not connected" from
  // the graph layer (repo not actually cloned) but must NOT be repo_not_owned.
  assert.notEqual(json.error?.code, "repo_not_owned");
  assert.notEqual(status, 403);
});

test("6. forbidden access: non-owner gets 403 repo_not_owned", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const { status, json } = await call("/repos/dependencies/acme/demo", await bearer(USER_B));
  assert.equal(status, 403);
  assert.equal(json.error?.code, "repo_not_owned");
});

test("7. unknown repo preserves not-connected style (404 repo_not_connected)", async () => {
  const { status, json } = await call("/repos/dependencies/never/connected", await bearer(USER_A));
  assert.equal(status, 404);
  assert.equal(json.error?.code, "repo_not_connected");
});

test("8. missing JWT -> 401 from auth middleware (before ownership)", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const { status, json } = await call("/repos/dependencies/acme/demo");
  assert.equal(status, 401);
  assert.equal(json.error?.code, "unauthorized");
});

test("9. invalid JWT -> 401 invalid_token (before ownership)", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const { status, json } = await call("/repos/dependencies/acme/demo", "Bearer not.a.jwt");
  assert.equal(status, 401);
  assert.equal(json.error?.code, "invalid_token");
});

test("10. summary route enforces ownership (non-owner 403)", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const { status, json } = await call("/repos/acme--demo/summary", await bearer(USER_B));
  assert.equal(status, 403);
  assert.equal(json.error?.code, "repo_not_owned");
});

test("11. search route enforces ownership (non-owner 403)", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  const { status, json } = await call("/repos/search/acme/demo?q=test", await bearer(USER_B));
  assert.equal(status, 403);
  assert.equal(json.error?.code, "repo_not_owned");
});
