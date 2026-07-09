import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BranchNameSchema,
  ChunkLimitSchema,
  CloneOptionsSchema,
  CommitShaSchema,
  FilePathSchema,
  GithubRepositoryUrlSchema,
  PaginationSchema,
  QuestionTextSchema,
  RepositoryIdSchema,
  RepositoryNameSchema,
  RepositoryOwnerSchema,
  SearchQuerySchema,
  SessionIdSchema,
  createPayloadSizeSchema,
} from "../validation/repositorySchemas.js";

function assertValid<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  return schema.parse(value);
}

function assertInvalid(schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): void {
  assert.equal(schema.safeParse(value).success, false, `${String(value)} should be invalid`);
}

test("valid repository names are accepted", () => {
  for (const name of ["demo", "giro.gtdev", "repo_name", "repo-name", "repo.1"]) {
    assert.equal(assertValid(RepositoryNameSchema, name), name);
  }
});

test("invalid repository names are rejected", () => {
  for (const name of [
    "",
    "../repo",
    "nested/repo",
    "nested\\repo",
    "bad\u0000repo",
    "repo name",
  ]) {
    assertInvalid(RepositoryNameSchema, name);
  }
});

test("valid owners are accepted", () => {
  assert.equal(assertValid(RepositoryOwnerSchema, "octocat"), "octocat");
  assert.equal(assertValid(RepositoryOwnerSchema, "a".repeat(39)), "a".repeat(39));
  assert.equal(assertValid(RepositoryOwnerSchema, "giro-dev"), "giro-dev");
});

test("invalid owners are rejected", () => {
  for (const owner of [
    "",
    "-leading",
    "trailing-",
    "has.dot",
    "has_space",
    "a".repeat(40),
  ]) {
    assertInvalid(RepositoryOwnerSchema, owner);
  }
});

test("valid GitHub URLs are accepted", () => {
  for (const url of [
    "https://github.com/octocat/hello-world",
    "https://github.com/octocat/hello-world.git",
    "git@github.com:octocat/hello-world.git",
  ]) {
    assert.equal(assertValid(GithubRepositoryUrlSchema, url), url);
  }
});

test("invalid GitHub URLs are rejected", () => {
  for (const url of [
    "http://github.com/octocat/hello-world",
    "https://gitlab.com/octocat/hello-world",
    "https://github.com/octocat",
    "https://github.com/octocat/../secret",
    "git@github.com:octocat/hello-world",
    "git@github.com:bad_owner/hello-world.git",
  ]) {
    assertInvalid(GithubRepositoryUrlSchema, url);
  }
});

test("branch traversal attempts and unsafe branch names are rejected", () => {
  assert.equal(assertValid(BranchNameSchema, "main"), "main");
  assert.equal(assertValid(BranchNameSchema, "feature/auth-audit"), "feature/auth-audit");

  for (const branch of [
    "../main",
    "feature/../main",
    "feature main",
    "bad\u0000branch",
    "..",
  ]) {
    assertInvalid(BranchNameSchema, branch);
  }
});

test("commit SHA validation requires 40 hexadecimal characters", () => {
  const sha = "a".repeat(40);

  assert.equal(assertValid(CommitShaSchema, sha), sha);
  assertInvalid(CommitShaSchema, "a".repeat(39));
  assertInvalid(CommitShaSchema, "g".repeat(40));
});

test("question text is trimmed, non-empty, and capped at 4000 characters", () => {
  assert.equal(assertValid(QuestionTextSchema, "  What does this repo do?  "), "What does this repo do?");
  assertInvalid(QuestionTextSchema, "   ");
  assertInvalid(QuestionTextSchema, "a".repeat(4001));
});

test("oversized payloads are rejected with configurable maximum", () => {
  const PayloadSchema = createPayloadSizeSchema(5);

  assert.equal(assertValid(PayloadSchema, "hello"), "hello");
  assertInvalid(PayloadSchema, "hello!");
});

test("pagination defaults and bounds are enforced", () => {
  assert.deepEqual(PaginationSchema.parse({}), {
    limit: 20,
    offset: 0,
  });
  assert.deepEqual(PaginationSchema.parse({ limit: "5", offset: "10" }), {
    limit: 5,
    offset: 10,
  });
  assertInvalid(PaginationSchema, { limit: 0, offset: 0 });
  assertInvalid(PaginationSchema, { limit: 101, offset: 0 });
  assertInvalid(PaginationSchema, { limit: 20, offset: -1 });
});

test("chunk limit, file path, session id, repository id, search query, and clone options parse deterministically", () => {
  assert.equal(ChunkLimitSchema.parse(500), 500);
  assertInvalid(ChunkLimitSchema, 501);

  assert.equal(FilePathSchema.parse("src/routes/repositories.ts"), "src/routes/repositories.ts");
  assertInvalid(FilePathSchema, "../secret.ts");
  assertInvalid(FilePathSchema, "/absolute.ts");

  assert.equal(SessionIdSchema.parse("session_123:abc"), "session_123:abc");
  assertInvalid(SessionIdSchema, "session/123");

  assert.equal(RepositoryIdSchema.parse("octocat/hello-world"), "octocat/hello-world");
  assertInvalid(RepositoryIdSchema, "octocat/hello/world");

  assert.equal(SearchQuerySchema.parse("  auth ownership  "), "auth ownership");
  assertInvalid(SearchQuerySchema, "a".repeat(501));

  assert.deepEqual(CloneOptionsSchema.parse({ branch: "main" }), {
    branch: "main",
    shallow: true,
    recursive: false,
  });
});

test("deterministic parsing returns identical outputs repeatedly", () => {
  const input = {
    branch: "feature/repository-validation",
    shallow: false,
    recursive: true,
  };

  assert.deepEqual(CloneOptionsSchema.parse(input), CloneOptionsSchema.parse(input));
  assert.deepEqual(PaginationSchema.parse({}), PaginationSchema.parse({}));
});

test("schema exports are immutable", () => {
  assert.equal(Object.isFrozen(RepositoryOwnerSchema), true);
  assert.equal(Object.isFrozen(RepositoryNameSchema), true);
  assert.equal(Object.isFrozen(GithubRepositoryUrlSchema), true);
  assert.equal(Object.isFrozen(CloneOptionsSchema), true);
  assert.equal(Object.isFrozen(createPayloadSizeSchema(10)), true);
});
