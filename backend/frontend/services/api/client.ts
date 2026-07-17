import type { ApiResponse } from "@/types/api";
import { API_BASE_URL } from "./config";

export type FieldErrors = Record<string, string[]>;

export interface NormalizedApiError {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  requestId?: string;
  fieldErrors?: FieldErrors;
}

export class ApiClientError extends Error implements NormalizedApiError {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly fieldErrors?: FieldErrors;

  constructor(input: NormalizedApiError) {
    super(input.message);
    this.name = "ApiClientError";
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId;
    this.retryable = input.retryable;
    this.fieldErrors = input.fieldErrors;
  }
}

export function notifyUnauthorized(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("giro:unauthorized"));
}

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

function fieldErrors(details: unknown): FieldErrors | undefined {
  if (!details || typeof details !== "object") return undefined;
  const source = "fieldErrors" in details && details.fieldErrors && typeof details.fieldErrors === "object"
    ? details.fieldErrors
    : details;
  const result: FieldErrors = {};
  for (const [field, messages] of Object.entries(source)) {
    if (Array.isArray(messages)) {
      const values = messages.filter((message): message is string => typeof message === "string");
      if (values.length > 0) result[field] = values;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function defaultRetryable(status: number): boolean {
  return status === 429 || status === 503 || status === 504 || status === 0;
}

function requestIdFrom(response: Response): string | undefined {
  return response.headers.get("X-Request-ID") ?? undefined;
}

function isApiResponse<T>(value: unknown): value is ApiResponse<T> {
  if (!value || typeof value !== "object" || !("success" in value) || !("requestId" in value)) return false;
  if (value.success === true) return "data" in value && typeof value.requestId === "string";
  if (value.success !== false || !("error" in value) || typeof value.requestId !== "string") return false;
  const error = value.error;
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error && typeof error.code === "string" &&
    "message" in error && typeof error.message === "string",
  );
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { token: string },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
        Authorization: `Bearer ${options.token}`,
      },
    });
  } catch {
    throw new ApiClientError({
      code: "network_error",
      message: "Unable to reach the Giro API.",
      status: 0,
      retryable: true,
    });
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new ApiClientError({
      code: "invalid_response",
      message: "The server returned an unreadable response.",
      status: response.status,
      requestId: requestIdFrom(response),
      retryable: defaultRetryable(response.status),
    });
  }

  if (!isApiResponse<T>(raw)) {
    throw new ApiClientError({
      code: "invalid_response",
      message: "The server returned an unexpected response shape.",
      status: response.status,
      requestId: requestIdFrom(response),
      retryable: defaultRetryable(response.status),
    });
  }
  const envelope = raw;

  if (!response.ok || !envelope.success) {
    if (response.status === 401) notifyUnauthorized();
    const error = envelope.success
      ? { code: "request_failed", message: response.statusText, retryable: response.status >= 500 }
      : envelope.error;
    throw new ApiClientError({
      code: error.code,
      message: error.message,
      status: response.status,
      requestId: envelope.requestId,
      retryable: error.retryable ?? defaultRetryable(response.status),
      fieldErrors: fieldErrors("details" in error ? error.details : undefined),
    });
  }

  return envelope.data;
}

export function isRetryableApiError(error: unknown): boolean {
  return error instanceof ApiClientError && error.retryable;
}

export function getApiErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return "Your session has expired. Sign in again.";
    if (error.code === "repo_not_connected" || error.code === "repo_not_found") return "Repository not found.";
    if (error.code === "indexing_job_not_found") return "No indexing job was found for this repository.";
    return error.message;
  }
  return "Something went wrong. Please try again.";
}
