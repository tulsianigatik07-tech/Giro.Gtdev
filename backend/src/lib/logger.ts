import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  requestId?: string;
  userId?: string;
  repositoryId?: string;
  sessionId?: string;
  workerId?: string;
  operation?: string;
}

export interface StructuredLogger {
  debug(operation: string, fields?: Record<string, unknown>): void;
  info(operation: string, fields?: Record<string, unknown>): void;
  warn(operation: string, fields?: Record<string, unknown>): void;
  error(operation: string, fields?: Record<string, unknown>): void;
}

export type LogWriter = (entry: string, level: LogLevel) => void;

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const LOG_CONTEXT_KEYS = new Set<keyof LogContext>([
  "requestId",
  "userId",
  "repositoryId",
  "sessionId",
  "workerId",
  "operation",
]);
const SENSITIVE_FIELD = /^(?:authorization|authorizationHeader|openaiApiKey|supabase(?:ServiceRole)?Key|serviceRoleKey|jwt|jwtToken|accessToken|refreshToken|idToken|token|prompt|promptContent|query|question|content|messages|input|context|embedding|embeddings|repositorySource|repositorySourceCode|sourceCode|fileContents|chunks)$/i;
const SECRET_TEXT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bBearer\s+\S+/gi, "Bearer [REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]"],
  [/([?&](?:key|token|secret|api_key|apikey)=)[^&\s]+/gi, "$1[REDACTED]"],
  [/((?:authorization|api[_-]?key|service[_-]?key|jwt|token|secret)\s*[:=]\s*)\S+/gi, "$1[REDACTED]"],
];
const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 12_000;

const logContextStorage = new AsyncLocalStorage<LogContext>();

function configuredLevel(): LogLevel {
  const candidate = process.env.LOG_LEVEL?.toLowerCase();
  return candidate === "debug" || candidate === "info" || candidate === "warn" || candidate === "error"
    ? candidate
    : process.env.NODE_ENV === "production" ? "info" : "debug";
}

function redactText(value: string): string {
  let redacted = value;
  for (const [pattern, replacement] of SECRET_TEXT_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted.length <= MAX_STRING_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_STRING_LENGTH)}…`;
}

function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (value instanceof Error) {
    return sanitize({ name: value.name, message: value.message, stack: value.stack }, depth + 1, seen);
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1, seen));

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_FIELD.test(key)
      ? "[REDACTED]"
      : sanitize(item, depth + 1, seen);
  }
  return output;
}

function compactFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

export function runWithLogContext<T>(context: LogContext, callback: () => T): T {
  return logContextStorage.run({ ...context }, callback);
}

export function updateLogContext(context: Partial<LogContext>): void {
  const active = logContextStorage.getStore();
  if (!active) return;
  for (const [key, value] of Object.entries(context) as Array<[keyof LogContext, string | undefined]>) {
    if (value === undefined) delete active[key];
    else active[key] = value;
  }
}

export function currentLogContext(): Readonly<LogContext> | undefined {
  return logContextStorage.getStore();
}

export function createLogger(
  writer: LogWriter,
  options: { level?: LogLevel; now?: () => Date } = {},
): StructuredLogger {
  const threshold = LEVEL_ORDER[options.level ?? configuredLevel()];
  const now = options.now ?? (() => new Date());

  const emit = (level: LogLevel, operation: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < threshold) return;
    const active = logContextStorage.getStore() ?? {};
    const sanitized = sanitize(compactFields({ ...active, ...fields })) as Record<string, unknown>;
    for (const key of LOG_CONTEXT_KEYS) {
      if (sanitized[key] === undefined) delete sanitized[key];
    }
    writer(JSON.stringify({
      ...sanitized,
      timestamp: now().toISOString(),
      level,
      operation: redactText(operation),
    }), level);
  };

  return {
    debug: (operation, fields) => emit("debug", operation, fields),
    info: (operation, fields) => emit("info", operation, fields),
    warn: (operation, fields) => emit("warn", operation, fields),
    error: (operation, fields) => emit("error", operation, fields),
  };
}

const stdoutWriter: LogWriter = (entry, level) => {
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${entry}\n`);
};

export const logger = createLogger(stdoutWriter);
export const stderrLogger = createLogger((entry) => process.stderr.write(`${entry}\n`));
