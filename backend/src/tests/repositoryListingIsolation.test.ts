import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import {
  setRepositoryOwner,
  clearRepositoryOwners,
} from "../services/repository/ownershipStore.js";
import {
  setRepositoryIndexed,
  clearRepositoryIndexRegistry,
} from "../services/repository/indexingService.js";

const USER_A = { userId: "user-a", email: "a@example.com" };
const USER_B = { userId: "user-b", email: "b@example.com" };

const TOKEN_A = `Bearer ${await signAccessToken(USER_A)}`;
const TOKEN_B = `Bearer ${await signAccessToken(USER_B)}`;

type IndexedRepo = { owner: string; repo: string };
type ApiResponse = {
  success: boolean;
  data?: { repositories: IndexedRepo[]; count: number };
  error?: { code: string; message: string };
};

function asData(json: ApiResponse): { repositories: IndexedRepo[]; count: number } {
  assert.ok(json.data, "expected data");
  return json.data;
}

async function listIndexed(authorization?: string) {
  const app = createApp();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;
  const res = await app.fetch(
    new Request("http://local/repos/indexed", { method: "GET", headers }),
  );
  const json = (await res.json().catch(() => ({}))) as ApiResponse;
  return { status: res.status, json };
}

const NO_COUNTS = {
  chunkCount: 0,
  fileCount: 0,
  symbolCount: 0,
  graphNodeCount: 0,
  graphEdgeCount: 0,
  summaryAvailable: false,
};

// Index a repo and (optionally) assign an owner.
function index(owner: string, repo: string, ownerUserId?: string): void {
  setRepositoryIndexed(owner, repo, NO_COUNTS);
  if (ownerUserId !== undefined) setRepositoryOwner(`${owner}/${repo}`, ownerUserId);
}

function paths(repos: IndexedRepo[]): string[] {
  return repos.map((r) => `${r.owner}/${r.repo}`);
}

beforeEach(() => {
  clearRepositoryIndexRegistry();
  clearRepositoryOwners();
});

test("1. user A sees only repositories they own", async () => {
  index("acme", "a1", USER_A.userId);
  index("acme", "a2", USER_A.userId);
  index("beta", "b1", USER_B.userId);

  const { status, json } = await listIndexed(TOKEN_A);
  assert.equal(status, 200);
  const data = asData(json);
  assert.equal(data.count, 2);
  assert.deepEqual(paths(data.repositories).sort(), ["acme/a1", "acme/a2"]);
});

test("2. user B sees only repositories they own", async () => {
  index("acme", "a1", USER_A.userId);
  index("beta", "b1", USER_B.userId);

  const { json } = await listIndexed(TOKEN_B);
  const data = asData(json);
  assert.equal(data.count, 1);
  assert.deepEqual(paths(data.repositories), ["beta/b1"]);
});

test("3. another user's repositories never appear", async () => {
  index("acme", "a1", USER_A.userId);
  index("beta", "b1", USER_B.userId);

  const { json } = await listIndexed(TOKEN_A);
  const data = asData(json);
  assert.ok(!paths(data.repositories).includes("beta/b1"));
});

test("4. indexed repositories with no owner are hidden from everyone", async () => {
  index("orphan", "noowner"); // indexed but unowned
  index("acme", "a1", USER_A.userId);

  const a = await listIndexed(TOKEN_A);
  const b = await listIndexed(TOKEN_B);
  assert.ok(!paths(asData(a.json).repositories).includes("orphan/noowner"));
  assert.ok(!paths(asData(b.json).repositories).includes("orphan/noowner"));
  // A still sees their own; B sees none.
  assert.equal(asData(a.json).count, 1);
  assert.equal(asData(b.json).count, 0);
});

test("5. sorting is preserved within a user's visible repositories", async () => {
  // listIndexedRepositories sorts by owner asc, repo asc; filtering preserves it.
  index("zeta", "z", USER_A.userId);
  index("alpha", "a", USER_A.userId);
  index("alpha", "b", USER_A.userId);

  const { json } = await listIndexed(TOKEN_A);
  assert.deepEqual(paths(asData(json).repositories), ["alpha/a", "alpha/b", "zeta/z"]);
});

test("6. count equals number of repositories visible to the user", async () => {
  index("acme", "a1", USER_A.userId);
  index("acme", "a2", USER_A.userId);
  index("acme", "a3", USER_A.userId);
  index("beta", "b1", USER_B.userId);

  const { json } = await listIndexed(TOKEN_A);
  const data = asData(json);
  assert.equal(data.count, data.repositories.length);
  assert.equal(data.count, 3);
});

test("7. missing Authorization header -> 401 unauthorized", async () => {
  index("acme", "a1", USER_A.userId);
  const { status, json } = await listIndexed();
  assert.equal(status, 401);
  assert.equal(json.error?.code, "unauthorized");
});

test("8. invalid/garbage JWT -> 401 invalid_token", async () => {
  index("acme", "a1", USER_A.userId);
  const { status, json } = await listIndexed("Bearer not.a.real.jwt");
  assert.equal(status, 401);
  assert.equal(json.error?.code, "invalid_token");
});

test("9. empty result when user owns no indexed repositories", async () => {
  index("beta", "b1", USER_B.userId);
  const { status, json } = await listIndexed(TOKEN_A);
  assert.equal(status, 200);
  const data = asData(json);
  assert.equal(data.count, 0);
  assert.deepEqual(data.repositories, []);
});
