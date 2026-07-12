export const DEADLINE_EXCEEDED_MESSAGE = "Operation deadline exceeded";

export class DeadlineExceededError extends Error {
  constructor() {
    super(DEADLINE_EXCEEDED_MESSAGE);
    this.name = "DeadlineExceededError";
  }
}

export interface DeadlineTimerOptions {
  now?: () => number;
  setTimer?: (callback: () => void, timeoutMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  parentSignal?: AbortSignal;
}

export interface Deadline {
  readonly signal: AbortSignal;
  remainingMs(): number;
  throwIfExpired(): void;
  dispose(): void;
}

export function isDeadlineExceeded(error: unknown): boolean {
  return error instanceof DeadlineExceededError ||
    (error instanceof Error && error.name === "DeadlineExceededError");
}

export function createDeadline(timeoutMs: number, options: DeadlineTimerOptions = {}): Deadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const controller = new AbortController();
  const expiresAt = now() + timeoutMs;
  let disposed = false;
  const expire = () => {
    if (!disposed && !controller.signal.aborted) controller.abort(new DeadlineExceededError());
  };
  const timer = setTimer(expire, timeoutMs);
  const parentAbort = () => {
    if (!controller.signal.aborted) controller.abort(options.parentSignal?.reason);
  };
  if (options.parentSignal?.aborted) parentAbort();
  else options.parentSignal?.addEventListener("abort", parentAbort, { once: true });

  return {
    signal: controller.signal,
    remainingMs: () => Math.max(0, expiresAt - now()),
    throwIfExpired() {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (now() >= expiresAt) {
        expire();
        throw controller.signal.reason;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer(timer);
      options.parentSignal?.removeEventListener("abort", parentAbort);
    },
  };
}

export async function waitForDeadline<T>(operation: Promise<T>, deadline: Deadline): Promise<T> {
  deadline.throwIfExpired();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      deadline.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(deadline.signal.reason));
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
