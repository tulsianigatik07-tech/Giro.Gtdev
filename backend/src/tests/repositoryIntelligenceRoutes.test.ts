import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import {
  clearRepositoryOwners,
  setRepositoryOwner,
} from "../services/repository/ownershipStore.js";

const USER_A = { userId: "user-a", email: "a@example.com" };
const USER_B = { userId: "user-b", email: "b@example.com" };

type ApiBody = {
  success?: boolean;
  error?: {
    code?: string;
  };
};

async function authHeader(user: typeof USER_A): Promise<string> {
  return `Bearer ${await signAccessToken(user)}`;
}

async function request(
  path: string,
  token?: string,
): Promise<{ status: number; body: ApiBody }> {
  const app = createApp();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = token;

  const res = await app.request(path, {
    method: "GET",
    headers,
  });

  const body = (await res.json().catch(() => ({}))) as ApiBody;

  return { status: res.status, body };
}

beforeEach(() => {
  clearRepositoryOwners();
});

describe("repository intelligence route ownership", () => {
  it("returns 401 without auth", async () => {
    const result = await request("/repos/intelligence/acme/demo");

    assert.equal(result.status, 401);
    assert.equal(result.body.error?.code, "unauthorized");
  });

  it("returns 404 when repo is not connected/owned", async () => {
    const token = await authHeader(USER_A);
    const result = await request("/repos/intelligence/acme/demo", token);

    assert.equal(result.status, 404);
    assert.equal(result.body.error?.code, "repo_not_connected");
  });

  it("returns 403 when repo belongs to another user", async () => {
    setRepositoryOwner("acme/demo", USER_A.userId);

    const token = await authHeader(USER_B);
    const result = await request("/repos/intelligence/acme/demo", token);

    assert.equal(result.status, 403);
    assert.equal(result.body.error?.code, "repo_not_owned");
  });

  it("valid owner passes auth and ownership checks", async () => {
    setRepositoryOwner("acme/demo", USER_A.userId);

    const token = await authHeader(USER_A);
    const result = await request("/repos/intelligence/acme/demo", token);

    assert.notEqual(result.status, 401);
    assert.notEqual(result.status, 403);

    if (result.status === 404) {
      assert.equal(result.body.error?.code, "repo_not_connected");
    }
  });
});