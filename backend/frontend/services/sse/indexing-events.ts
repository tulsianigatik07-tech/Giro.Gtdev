import { ApiClientError, apiUrl, notifyUnauthorized } from "@/services/api/client";
import type { ApiResponse, IndexingProgress } from "@/types/api";

export interface IndexingEventHandlers {
  onProgress(event: IndexingProgress): void;
  onConnectionChange?(connected: boolean): void;
  onReconnect?(attempt: number, delayMs: number): void;
  onError?(error: Error): void;
}

interface StreamEvent {
  event: string;
  data: string;
}

const activeStreams = new Map<string, AbortController>();
const MAX_RECONNECT_ATTEMPTS = 5;

function fieldValue(line: string, field: string): string | null {
  if (!line.startsWith(`${field}:`)) return null;
  const value = line.slice(field.length + 1);
  return value.startsWith(" ") ? value.slice(1) : value;
}

export function parseSseBlock(block: string): StreamEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const eventValue = fieldValue(line, "event");
    if (eventValue !== null) event = eventValue || "message";
    const dataValue = fieldValue(line, "data");
    if (dataValue !== null) data.push(dataValue);
  }
  return data.length > 0 ? { event, data: data.join("\n") } : null;
}

function parseProgress(event: StreamEvent): IndexingProgress {
  let value: unknown;
  try {
    value = JSON.parse(event.data);
  } catch {
    throw new ApiClientError({
      code: "invalid_sse_event",
      message: "The indexing stream returned malformed event data.",
      status: 200,
      retryable: true,
    });
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("jobId" in value) || typeof value.jobId !== "string" ||
    !("repositoryId" in value) || typeof value.repositoryId !== "string" ||
    !("stage" in value) || typeof value.stage !== "string" ||
    !("percentage" in value) || typeof value.percentage !== "number" ||
    !("message" in value) || typeof value.message !== "string" ||
    !("timestamp" in value) || typeof value.timestamp !== "string"
  ) {
    throw new ApiClientError({
      code: "invalid_sse_event",
      message: "The indexing stream returned an unexpected event shape.",
      status: 200,
      retryable: true,
    });
  }
  return value as IndexingProgress;
}

function isTerminal(event: StreamEvent, progress: IndexingProgress): boolean {
  return event.event === "completed" || event.event === "failed" ||
    progress.stage === "completed" || progress.stage === "failed";
}

async function streamError(response: Response): Promise<ApiClientError> {
  let envelope: ApiResponse<never> | null = null;
  try {
    envelope = await response.json() as ApiResponse<never>;
  } catch {
    // The status-specific fallback below is still actionable.
  }
  const requestId = envelope?.requestId ?? response.headers.get("X-Request-ID") ?? undefined;
  const backendError = envelope && !envelope.success ? envelope.error : null;
  const defaults: Record<number, { code: string; message: string; retryable: boolean }> = {
    401: { code: "unauthorized", message: "Your session has expired. Sign in again.", retryable: false },
    403: { code: "repo_not_owned", message: "You do not have access to this repository.", retryable: false },
    404: { code: "indexing_job_not_found", message: "No indexing job was found for this repository.", retryable: false },
    429: { code: "rate_limit_exceeded", message: "Indexing progress is rate limited. Retrying shortly.", retryable: true },
  };
  const fallback = defaults[response.status] ?? {
    code: "sse_unavailable",
    message: "Indexing progress is temporarily unavailable.",
    retryable: response.status >= 500,
  };
  if (response.status === 401) notifyUnauthorized();
  return new ApiClientError({
    code: backendError?.code ?? fallback.code,
    message: backendError?.message ?? fallback.message,
    status: response.status,
    requestId,
    retryable: backendError?.retryable ?? fallback.retryable,
  });
}

export async function consumeIndexingStream(
  repositoryId: string,
  token: string,
  handlers: IndexingEventHandlers,
  signal: AbortSignal,
): Promise<"terminal"> {
  let response: Response;
  try {
    response = await fetch(
      apiUrl(`/repositories/${encodeURIComponent(repositoryId)}/indexing/events`),
      { headers: { Accept: "text/event-stream", Authorization: `Bearer ${token}` }, signal },
    );
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiClientError({
      code: "network_error",
      message: "The indexing stream disconnected.",
      status: 0,
      retryable: true,
    });
  }
  if (!response.ok || !response.body) throw await streamError(response);

  handlers.onConnectionChange?.(true);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const parsed = parseSseBlock(block);
        if (!parsed || parsed.event === "heartbeat") continue;
        const progress = parseProgress(parsed);
        handlers.onProgress(progress);
        if (isTerminal(parsed, progress)) return "terminal";
      }
    }
  } finally {
    handlers.onConnectionChange?.(false);
    reader.releaseLock();
  }

  throw new ApiClientError({
    code: "sse_disconnected",
    message: "The indexing stream disconnected before indexing finished.",
    status: 0,
    retryable: true,
  });
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export async function subscribeToIndexing(
  repositoryId: string,
  token: string,
  handlers: IndexingEventHandlers,
  signal: AbortSignal,
): Promise<void> {
  activeStreams.get(repositoryId)?.abort();
  const controller = new AbortController();
  activeStreams.set(repositoryId, controller);
  signal.addEventListener("abort", () => controller.abort(), { once: true });

  let attempt = 0;
  try {
    while (!controller.signal.aborted) {
      try {
        await consumeIndexingStream(repositoryId, token, handlers, controller.signal);
        return;
      } catch (error) {
        if (controller.signal.aborted) return;
        const normalized = error instanceof Error ? error : new Error("Indexing stream disconnected.");
        handlers.onError?.(normalized);
        if (error instanceof ApiClientError && !error.retryable) return;
        if (attempt >= MAX_RECONNECT_ATTEMPTS) return;
        const delay = Math.min(1000 * 2 ** attempt, 10_000);
        attempt += 1;
        handlers.onReconnect?.(attempt, delay);
        await waitForRetry(delay, controller.signal);
      }
    }
  } finally {
    if (activeStreams.get(repositoryId) === controller) activeStreams.delete(repositoryId);
  }
}
