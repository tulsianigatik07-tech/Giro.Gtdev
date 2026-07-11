export type ShutdownSignal = "SIGINT" | "SIGTERM";
export type ShutdownOutcome = "completed" | "failed" | "timeout" | "forced";

export interface ShutdownResult {
  readonly signal: ShutdownSignal;
  readonly outcome: ShutdownOutcome;
  readonly exitCode: 0 | 1;
}

export interface ShutdownLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface CleanupTask {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

export interface ShutdownCoordinatorOptions {
  logger: ShutdownLogger;
  timeoutMs: number;
  stopAcceptingRequests?: () => void | Promise<void>;
  cleanupTasks?: readonly CleanupTask[];
  forceStop?: () => void | Promise<void>;
  setTimer?: (callback: () => void, timeoutMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ShutdownCoordinator {
  requestShutdown(signal: ShutdownSignal): Promise<ShutdownResult>;
  isShuttingDown(): boolean;
  getShutdownState(): Readonly<{
    phase: "running" | "shutting_down" | "completed" | "forced";
    signal: ShutdownSignal | null;
  }>;
}

export function createShutdownCoordinator(
  options: ShutdownCoordinatorOptions,
): ShutdownCoordinator {
  const tasks = Object.freeze([...(options.cleanupTasks ?? [])]);
  const setTimer =
    options.setTimer ??
    ((callback, timeoutMs) => setTimeout(callback, timeoutMs));
  const clearTimer =
    options.clearTimer ??
    ((handle) => clearTimeout(handle as NodeJS.Timeout));
  let phase: "running" | "shutting_down" | "completed" | "forced" = "running";
  let firstSignal: ShutdownSignal | null = null;
  let completion: Promise<ShutdownResult> | null = null;
  let resolveCompletion: ((result: ShutdownResult) => void) | null = null;
  let timer: unknown;
  let forceStopRequested = false;

  function state() {
    return Object.freeze({ phase, signal: firstSignal });
  }

  function force(outcome: "timeout" | "forced"): void {
    if (phase !== "shutting_down" || !firstSignal) return;
    phase = "forced";
    clearTimer(timer);
    if (!forceStopRequested) {
      forceStopRequested = true;
      void Promise.resolve(options.forceStop?.()).catch(() => undefined);
    }
    options.logger.error(
      outcome === "timeout" ? "shutdown_timeout" : "shutdown_forced",
      { signal: firstSignal },
    );
    resolveCompletion?.(
      Object.freeze({ signal: firstSignal, outcome, exitCode: 1 }),
    );
    resolveCompletion = null;
  }

  async function run(signal: ShutdownSignal): Promise<void> {
    let failed = false;
    const orderedTasks: readonly CleanupTask[] = options.stopAcceptingRequests
      ? [
          {
            name: "stop_accepting_requests",
            run: options.stopAcceptingRequests,
          },
          ...tasks,
        ]
      : tasks;

    for (const task of orderedTasks) {
      try {
        await task.run();
        if (phase !== "shutting_down") return;
        options.logger.info("shutdown_task_completed", { task: task.name });
      } catch {
        failed = true;
        options.logger.error("shutdown_task_failed", { task: task.name });
      }
    }

    if (phase !== "shutting_down") return;
    clearTimer(timer);
    phase = "completed";
    const result: ShutdownResult = {
      signal,
      outcome: failed ? "failed" : "completed",
      exitCode: failed ? 1 : 0,
    };
    options.logger.info("shutdown_completed", {
      signal,
      exit_code: result.exitCode,
    });
    resolveCompletion?.(Object.freeze(result));
    resolveCompletion = null;
  }

  return {
    requestShutdown(signal) {
      options.logger.info("shutdown_requested", { signal });
      if (phase === "shutting_down") {
        force("forced");
        return completion!;
      }
      if (completion) return completion;

      phase = "shutting_down";
      firstSignal = signal;
      options.logger.info("shutdown_started", { signal });
      completion = new Promise<ShutdownResult>((resolve) => {
        resolveCompletion = resolve;
      });
      timer = setTimer(() => force("timeout"), options.timeoutMs);
      void run(signal);
      return completion;
    },
    isShuttingDown: () => phase !== "running",
    getShutdownState: state,
  };
}
