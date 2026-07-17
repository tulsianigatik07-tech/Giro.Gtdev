import { beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import {
  clearRepositoryOwners,
  setRepositoryOwner,
} from "../services/repository/ownershipStore.js";

const USER_A = { userId: "retrieval-user-a", email: "a@example.com" };
const USER_B = { userId: "retrieval-user-b", email: "b@example.com" };

async function requestHybrid(user: typeof USER_A) {
  const token = await signAccessToken(user);
  const response = await createApp().request("/retrieval/hybrid", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "authentication", owner: "acme", repo: "demo" }),
  });
  return {
    status: response.status,
    body: await response.json() as { error?: { code?: string } },
  };
}

beforeEach(() => clearRepositoryOwners());

describe("retrieval inspector ownership", () => {
  it("returns 404 when the repository is not connected", async () => {
    const result = await requestHybrid(USER_A);
    assert.equal(result.status, 404);
    assert.equal(result.body.error?.code, "repo_not_connected");
  });

  it("returns 403 when the repository belongs to another user", async () => {
    setRepositoryOwner("acme/demo", USER_A.userId);
    const result = await requestHybrid(USER_B);
    assert.equal(result.status, 403);
    assert.equal(result.body.error?.code, "repo_not_owned");
  });
});
