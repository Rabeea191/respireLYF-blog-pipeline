/**
 * Structured logger — every agent call is logged with stage, iteration, duration.
 * Writes JSON in production (Vercel), human-readable in dev.
 */

type LogLevel = "info" | "warn" | "error" | "debug";

interface LogEntry {
  level: LogLevel;
  stage: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
  duration_ms?: number;
  run_id?: string;
  iteration?: number;
}

const IS_DEV = process.env.NODE_ENV !== "production";

function format(entry: LogEntry): string {
  if (IS_DEV) {
    const prefix = {
      info:  "ℹ️ ",
      warn:  "⚠️ ",
      error: "❌",
      debug: "🔍",
    }[entry.level];
    const dur = entry.duration_ms ? ` (${entry.duration_ms}ms)` : "";
    const iter = entry.iteration !== undefined ? ` [iter ${entry.iteration}]` : "";
    return `${prefix} [${entry.stage}]${iter}${dur} ${entry.message}${
      entry.data ? "\n" + JSON.stringify(entry.data, null, 2) : ""
    }`;
  }
  return JSON.stringify(entry);
}

function log(
  level: LogLevel,
  stage: string,
  message: string,
  opts?: { data?: Record<string, unknown>; duration_ms?: number; run_id?: string; iteration?: number }
) {
  const entry: LogEntry = {
    level,
    stage,
    message,
    timestamp: new Date().toISOString(),
    ...opts,
  };
  if (level === "error") {
    console.error(format(entry));
  } else {
    console.log(format(entry));
  }
  return entry;
}

export const logger = {
  info:  (stage: string, msg: string, opts?: Parameters<typeof log>[3]) => log("info",  stage, msg, opts),
  warn:  (stage: string, msg: string, opts?: Parameters<typeof log>[3]) => log("warn",  stage, msg, opts),
  error: (stage: string, msg: string, opts?: Parameters<typeof log>[3]) => log("error", stage, msg, opts),
  debug: (stage: string, msg: string, opts?: Parameters<typeof log>[3]) => log("debug", stage, msg, opts),

  /** Wrap an async fn and automatically log duration + success/failure */
  async timed<T>(
    stage: string,
    label: string,
    fn: () => Promise<T>,
    run_id?: string
  ): Promise<T> {
    const start = Date.now();
    logger.info(stage, `Starting: ${label}`, { run_id });
    try {
      const result = await fn();
      logger.info(stage, `Done: ${label}`, { duration_ms: Date.now() - start, run_id });
      return result;
    } catch (err) {
      logger.error(stage, `Failed: ${label}`, {
        duration_ms: Date.now() - start,
        run_id,
        data: { error: String(err) },
      });
      throw err;
    }
  },
};
