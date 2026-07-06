import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  clearRepositoryRegistry,
  getRepository,
  listRepositories,
  registerRepository,
  removeRepository,
  repositoryCount,
  repositoryExists,
  type RepositoryIndexRegistryEntry,
} from "../services/repository/repositoryIndexRegistry.js";

function repository(
  repositoryId: string,
  overrides: Partial<RepositoryIndexRegistryEntry> = {},
): RepositoryIndexRegistryEntry {
  const [owner = "unknown", repo = "unknown"] = repositoryId.split("/");

  return {
    repositoryId,
    owner,
    repo,
    status: "indexed",
    indexedAt: "2026-01-01T00:00:00.000Z",
    lastAccessed: "2026-01-02T00:00:00.000Z",
    ready: true,
    metadataAvailable: true,
    symbolCount: 12,
    fileCount: 34,
    graphAvailable: true,
    health: "healthy",
    ...overrides,
  };
}

beforeEach(() => {
  clearRepositoryRegistry();
});

describe("repository index registry", () => {
  it("starts empty", () => {
    assert.equal(repositoryCount(), 0);
    assert.deepEqual(listRepositories(), []);
    assert.equal(getRepository("acme/demo"), null);
    assert.equal(repositoryExists("acme/demo"), false);
  });

  it("registers a repository", () => {
    const registered = registerRepository(repository("acme/demo"));

    assert.equal(repositoryCount(), 1);
    assert.equal(repositoryExists("acme/demo"), true);
    assert.deepEqual(getRepository("acme/demo"), registered);
  });

  it("replaces an existing repository registration", () => {
    registerRepository(repository("acme/demo", { status: "indexing", ready: false }));
    registerRepository(repository("acme/demo", { symbolCount: 99, status: "indexed" }));

    assert.equal(repositoryCount(), 1);
    assert.equal(getRepository("acme/demo")?.status, "indexed");
    assert.equal(getRepository("acme/demo")?.symbolCount, 99);
  });

  it("removes a repository", () => {
    registerRepository(repository("acme/demo"));

    removeRepository("acme/demo");

    assert.equal(repositoryCount(), 0);
    assert.equal(repositoryExists("acme/demo"), false);
    assert.equal(getRepository("acme/demo"), null);
  });

  it("does not throw when removing an unknown repository", () => {
    assert.doesNotThrow(() => removeRepository("ghost/missing"));
    assert.equal(repositoryCount(), 0);
  });

  it("looks up repositories by repositoryId", () => {
    registerRepository(repository("acme/demo"));
    registerRepository(repository("beta/api"));

    assert.equal(getRepository("acme/demo")?.repo, "demo");
    assert.equal(getRepository("beta/api")?.owner, "beta");
    assert.equal(getRepository("missing/repo"), null);
  });

  it("lists all repositories", () => {
    registerRepository(repository("acme/demo"));
    registerRepository(repository("beta/api"));

    assert.deepEqual(
      listRepositories().map((entry) => entry.repositoryId),
      ["acme/demo", "beta/api"],
    );
  });

  it("lists repositories in stable repositoryId order", () => {
    registerRepository(repository("zeta/web"));
    registerRepository(repository("acme/demo"));
    registerRepository(repository("acme/api"));

    assert.deepEqual(
      listRepositories().map((entry) => entry.repositoryId),
      ["acme/api", "acme/demo", "zeta/web"],
    );
  });

  it("does not expose internal state", () => {
    const original = repository("acme/demo");
    registerRepository(original);
    original.status = "mutated";
    original.symbolCount = -1;

    const found = getRepository("acme/demo");
    assert.ok(found);
    found.status = "mutated-again";
    found.symbolCount = -2;

    const listed = listRepositories();
    listed[0]!.status = "mutated-from-list";
    listed[0]!.symbolCount = -3;

    assert.equal(getRepository("acme/demo")?.status, "indexed");
    assert.equal(getRepository("acme/demo")?.symbolCount, 12);
  });

  it("returns deterministic repeated output", () => {
    registerRepository(repository("zeta/web"));
    registerRepository(repository("acme/demo"));
    registerRepository(repository("beta/api"));

    const first = listRepositories();
    const second = listRepositories();

    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
  });
});
