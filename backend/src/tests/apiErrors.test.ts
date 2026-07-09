import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createApiError,
  createAuthError,
  createAuthorizationError,
  createRepositoryError,
  createSessionError,
  createValidationError,
  normalizeUnknownError,
  type ApiErrorCategory,
  type ApiErrorCode,
  type ApiErrorStatus,
} from "../lib/apiErrors.js";
import type { ApiError } from "../types/response.js";

const EXPECTED_DEFAULTS: Array<{
  code: ApiErrorCode;
  status: ApiErrorStatus;
  category: ApiErrorCategory;
  retryable: boolean;
}> = [
  { code: "validation_failed", status: 400, category: "validation", retryable: false },
  { code: "unauthenticated", status: 401, category: "authentication", retryable: false },
  { code: "unauthorized", status: 403, category: "authorization", retryable: false },
  { code: "repo_not_found", status: 404, category: "repository", retryable: false },
  { code: "repo_not_connected", status: 404, category: "repository", retryable: false },
  { code: "repo_not_owned", status: 403, category: "repository", retryable: false },
  { code: "session_not_found", status: 404, category: "session", retryable: false },
  { code: "session_not_owned", status: 403, category: "session", retryable: false },
  { code: "invalid_repo_url", status: 400, category: "validation", retryable: false },
  { code: "clone_failed", status: 500, category: "repository", retryable: true },
  { code: "indexing_failed", status: 500, category: "indexing", retryable: true },
  { code: "retrieval_failed", status: 500, category: "retrieval", retryable: true },
  { code: "embedding_failed", status: 502, category: "external", retryable: true },
  { code: "openai_unavailable", status: 503, category: "external", retryable: true },
  { code: "supabase_unavailable", status: 503, category: "external", retryable: true },
  { code: "rate_limited", status: 429, category: "rate_limit", retryable: true },
  { code: "payload_too_large", status: 413, category: "validation", retryable: false },
  { code: "internal_error", status: 500, category: "internal", retryable: false },
];

test("createApiError returns stable defaults for every code", () => {
  for (const expected of EXPECTED_DEFAULTS) {
    assert.deepEqual(createApiError(expected.code, "message"), {
      code: expected.code,
      message: "message",
      details: undefined,
      retryable: expected.retryable,
      status: expected.status,
      category: expected.category,
    });
  }
});

test("createApiError supports deterministic option overrides", () => {
  assert.deepEqual(
    createApiError("internal_error", "temporary outage", {
      details: { request: "abc" },
      retryable: true,
      status: 503,
      category: "external",
    }),
    {
      code: "internal_error",
      message: "temporary outage",
      details: { request: "abc" },
      retryable: true,
      status: 503,
      category: "external",
    },
  );
});

test("createValidationError includes details and is non-retryable", () => {
  const details = {
    fieldErrors: {
      owner: ["Invalid owner"],
    },
  };

  const error = createValidationError(details);

  assert.deepEqual(error, {
    code: "validation_failed",
    message: "Validation failed",
    details,
    retryable: false,
    status: 400,
    category: "validation",
  });
});

test("auth error status and category are stable", () => {
  assert.deepEqual(createAuthError(), {
    code: "unauthenticated",
    message: "Authentication required",
    details: undefined,
    retryable: false,
    status: 401,
    category: "authentication",
  });
});

test("authorization error supports custom message", () => {
  assert.deepEqual(createAuthorizationError("Repository access denied"), {
    code: "unauthorized",
    message: "Repository access denied",
    details: undefined,
    retryable: false,
    status: 403,
    category: "authorization",
  });
});

test("repository error status and category are stable", () => {
  assert.deepEqual(
    createRepositoryError("repo_not_owned", "You do not have access to this repository."),
    {
      code: "repo_not_owned",
      message: "You do not have access to this repository.",
      details: undefined,
      retryable: false,
      status: 403,
      category: "repository",
    },
  );
});

test("session error status and category are stable", () => {
  assert.deepEqual(createSessionError("session_not_found", "Session not found"), {
    code: "session_not_found",
    message: "Session not found",
    details: undefined,
    retryable: false,
    status: 404,
    category: "session",
  });
});

test("external errors are retryable", () => {
  assert.equal(createApiError("openai_unavailable", "OpenAI unavailable").retryable, true);
  assert.equal(createApiError("supabase_unavailable", "Supabase unavailable").retryable, true);
  assert.equal(createApiError("embedding_failed", "Embedding failed").retryable, true);
});

test("validation errors are not retryable", () => {
  assert.equal(createValidationError({ field: "repoUrl" }).retryable, false);
  assert.equal(createApiError("payload_too_large", "Payload too large").retryable, false);
});

test("normalizeUnknownError handles Error, string, and empty unknown values", () => {
  assert.deepEqual(normalizeUnknownError(new Error("boom")), {
    code: "internal_error",
    message: "boom",
    details: undefined,
    retryable: false,
    status: 500,
    category: "internal",
  });
  assert.equal(normalizeUnknownError("plain failure").message, "plain failure");
  assert.equal(normalizeUnknownError(null).message, "Unknown error");
});

test("repeated output is deterministic", () => {
  const first = createRepositoryError("repo_not_connected", "Repository not connected", {
    details: { repository: "acme/demo" },
  });
  const second = createRepositoryError("repo_not_connected", "Repository not connected", {
    details: { repository: "acme/demo" },
  });

  assert.deepEqual(first, second);
});

test("returned errors and copied details are immutable", () => {
  const details = { nested: { field: "repo" } };
  const error = createValidationError(details);

  details.nested.field = "changed";

  assert.equal(Object.isFrozen(error), true);
  assert.equal(Object.isFrozen(error.details), true);
  assert.equal(Object.isFrozen((error.details as typeof details).nested), true);
  assert.deepEqual(error.details, { nested: { field: "repo" } });
});

test("standard errors remain compatible with fail() ApiError input shape", () => {
  const error = createApiError("internal_error", "Internal error");
  const compatible: ApiError = error;

  assert.equal(compatible.code, "internal_error");
  assert.equal(compatible.message, "Internal error");
});
