// Minimal structured JSON logger.
// Keeps zero runtime dependencies; we can swap to pino later without changing call sites.

import { env } from "../config/env.js";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function shouldLog(level: Level): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[env.LOG_LEVEL];
}

type LogWriter = (entry: string) => void;

function emit(
  writer: LogWriter,
  level: Level,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  if (!shouldLog(level)) return;
  const entry = {
    level,
    time: new Date().toISOString(),
    msg,
    ...fields,
  };
  // eslint-disable-next-line no-console
  writer(JSON.stringify(entry));
}

function createLogger(writer: LogWriter) {
  return {
    debug: (msg: string, fields?: Record<string, unknown>) =>
      emit(writer, "debug", msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) =>
      emit(writer, "info", msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) =>
      emit(writer, "warn", msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) =>
      emit(writer, "error", msg, fields),
  };
}

export const logger = createLogger((entry) => console.log(entry));
export const stderrLogger = createLogger((entry) => console.error(entry));
