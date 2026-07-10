export type ApiErrorCode =
  | "validation_failed"
  | "unauthenticated"
  | "unauthorized"
  | "repo_not_found"
  | "repo_not_connected"
  | "repo_not_owned"
  | "session_not_found"
  | "session_not_owned"
  | "invalid_repo_url"
  | "clone_failed"
  | "indexing_job_not_found"
  | "indexing_failed"
  | "retrieval_failed"
  | "embedding_failed"
  | "openai_unavailable"
  | "supabase_unavailable"
  | "rate_limited"
  | "payload_too_large"
  | "internal_error";

export type ApiErrorCategory =
  | "validation"
  | "authentication"
  | "authorization"
  | "repository"
  | "session"
  | "indexing"
  | "retrieval"
  | "external"
  | "rate_limit"
  | "internal";

export type ApiErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 413
  | 422
  | 429
  | 500
  | 502
  | 503;

export interface StandardApiError {
  code: ApiErrorCode;
  message: string;
  details: unknown;
  retryable: boolean;
  status: ApiErrorStatus;
  category: ApiErrorCategory;
}

export interface CreateApiErrorOptions {
  details?: unknown;
  retryable?: boolean;
  status?: ApiErrorStatus;
  category?: ApiErrorCategory;
}

type ApiErrorDefaults = {
  status: ApiErrorStatus;
  category: ApiErrorCategory;
  retryable: boolean;
};

const ERROR_DEFAULTS: Record<ApiErrorCode, ApiErrorDefaults> = {
  validation_failed: { status: 400, category: "validation", retryable: false },
  unauthenticated: { status: 401, category: "authentication", retryable: false },
  unauthorized: { status: 403, category: "authorization", retryable: false },
  repo_not_found: { status: 404, category: "repository", retryable: false },
  repo_not_connected: { status: 404, category: "repository", retryable: false },
  repo_not_owned: { status: 403, category: "repository", retryable: false },
  session_not_found: { status: 404, category: "session", retryable: false },
  session_not_owned: { status: 403, category: "session", retryable: false },
  invalid_repo_url: { status: 400, category: "validation", retryable: false },
  clone_failed: { status: 500, category: "repository", retryable: true },
  indexing_job_not_found: { status: 404, category: "indexing", retryable: false },
  indexing_failed: { status: 500, category: "indexing", retryable: true },
  retrieval_failed: { status: 500, category: "retrieval", retryable: true },
  embedding_failed: { status: 502, category: "external", retryable: true },
  openai_unavailable: { status: 503, category: "external", retryable: true },
  supabase_unavailable: { status: 503, category: "external", retryable: true },
  rate_limited: { status: 429, category: "rate_limit", retryable: true },
  payload_too_large: { status: 413, category: "validation", retryable: false },
  internal_error: { status: 500, category: "internal", retryable: false },
};

const REPOSITORY_CODES = [
  "repo_not_found",
  "repo_not_connected",
  "repo_not_owned",
  "invalid_repo_url",
  "clone_failed",
] as const satisfies readonly ApiErrorCode[];

const SESSION_CODES = [
  "session_not_found",
  "session_not_owned",
] as const satisfies readonly ApiErrorCode[];

export type RepositoryApiErrorCode = (typeof REPOSITORY_CODES)[number];
export type SessionApiErrorCode = (typeof SESSION_CODES)[number];

function copyDetails(details: unknown): unknown {
  if (details === undefined || details === null) return details;
  if (typeof details !== "object") return details;

  return structuredClone(details);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return value;

  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }

  return Object.freeze(value);
}

function isRepositoryCode(code: ApiErrorCode): code is RepositoryApiErrorCode {
  return REPOSITORY_CODES.includes(code as RepositoryApiErrorCode);
}

function isSessionCode(code: ApiErrorCode): code is SessionApiErrorCode {
  return SESSION_CODES.includes(code as SessionApiErrorCode);
}

export function createApiError(
  code: ApiErrorCode,
  message: string,
  options: CreateApiErrorOptions = {},
): StandardApiError {
  const defaults = ERROR_DEFAULTS[code];

  return deepFreeze({
    code,
    message,
    details: copyDetails(options.details),
    retryable: options.retryable ?? defaults.retryable,
    status: options.status ?? defaults.status,
    category: options.category ?? defaults.category,
  });
}

export function createValidationError(details: unknown): StandardApiError {
  return createApiError("validation_failed", "Validation failed", { details });
}

export function createAuthError(): StandardApiError {
  return createApiError("unauthenticated", "Authentication required");
}

export function createAuthorizationError(message = "Access denied"): StandardApiError {
  return createApiError("unauthorized", message);
}

export function createRepositoryError(
  code: RepositoryApiErrorCode,
  message: string,
  options: CreateApiErrorOptions = {},
): StandardApiError {
  if (!isRepositoryCode(code)) {
    return createApiError("internal_error", "Invalid repository error code");
  }

  return createApiError(code, message, options);
}

export function createSessionError(
  code: SessionApiErrorCode,
  message: string,
  options: CreateApiErrorOptions = {},
): StandardApiError {
  if (!isSessionCode(code)) {
    return createApiError("internal_error", "Invalid session error code");
  }

  return createApiError(code, message, options);
}

export function normalizeUnknownError(error: unknown): StandardApiError {
  if (error instanceof Error) {
    return createApiError("internal_error", error.message);
  }

  if (typeof error === "string" && error.length > 0) {
    return createApiError("internal_error", error);
  }

  return createApiError("internal_error", "Unknown error");
}
