import {
  createShutdownCoordinator,
  type ShutdownLogger,
  type ShutdownResult,
  type ShutdownSignal,
} from "./shutdownCoordinator.js";

export interface OneShotCommandResult {
  readonly status: "idle" | "succeeded" | "failed";
}

export interface OneShotWorkerRuntimeOptions<T extends OneShotCommandResult> {
  timeoutMs: number;
  logger: ShutdownLogger;
  runCommand: (writeOutput: (output: string) => void) => Promise<T>;
  writeOutput: (output: string) => void;
  interruptedOutput: string;
  subscribeToSignal: (
    signal: ShutdownSignal,
    handler: () => void,
  ) => () => void;
  setExitCode: (code: 0 | 1) => void;
  forceExit: (code: 1) => void;
  setTimer?: (callback: () => void, timeoutMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export async function runOneShotWorkerRuntime<T extends OneShotCommandResult>(
  options: OneShotWorkerRuntimeOptions<T>,
): Promise<T | null> {
  let outputWritten = false;
  let commandResult: T | null = null;
  const writeOnce = (output: string) => {
    if (outputWritten) return;
    outputWritten = true;
    options.writeOutput(output);
  };
  const command = options.runCommand(writeOnce).then((result) => {
    commandResult = result;
    return result;
  });
  const coordinator = createShutdownCoordinator({
    logger: options.logger,
    timeoutMs: options.timeoutMs,
    cleanupTasks: [
      {
        name: "active_indexing_operation",
        run: async () => {
          await command;
        },
      },
    ],
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
  });

  let shutdownResultApplied = false;
  let shutdownCompletion: Promise<ShutdownResult> | null = null;
  let resolveForced: (() => void) | null = null;
  const forced = new Promise<null>((resolve) => {
    resolveForced = () => resolve(null);
  });
  const applyShutdownResult = (result: ShutdownResult) => {
    if (shutdownResultApplied) return;
    shutdownResultApplied = true;
    const commandFailed = commandResult?.status === "failed";
    const exitCode = result.exitCode === 1 || commandFailed ? 1 : 0;
    if (result.outcome === "timeout" || result.outcome === "forced") {
      writeOnce(options.interruptedOutput);
      options.setExitCode(1);
      options.forceExit(1);
      resolveForced?.();
      return;
    }
    options.setExitCode(exitCode);
  };

  const onSignal = (signal: ShutdownSignal) => {
    shutdownCompletion = coordinator.requestShutdown(signal);
    void shutdownCompletion.then(applyShutdownResult);
  };
  const unsubscribe = [
    options.subscribeToSignal("SIGINT", () => onSignal("SIGINT")),
    options.subscribeToSignal("SIGTERM", () => onSignal("SIGTERM")),
  ];

  try {
    const result = await Promise.race([command, forced]);
    if (!result) return null;
    if (!coordinator.isShuttingDown()) {
      options.setExitCode(result.status === "failed" ? 1 : 0);
    } else if (shutdownCompletion) {
      await shutdownCompletion;
    }
    return result;
  } finally {
    for (const remove of unsubscribe) remove();
  }
}
