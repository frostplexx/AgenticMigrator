// Shared winston logger for agentic-migrator.
//
// Controlled by env vars:
//   LOG_LEVEL   — one of error, warn, success, info, http, verbose, debug, silly (default: info)
//   NODE_ENV    — 'production' disables colorized output in favour of JSON
//   LOG_FILE    — optional path for JSONL output (created lazily to avoid Docker mount races)
//
// Every module imports this single instance; use logger.child({ module: '...' }) if you
// need a per-module label so the source is clear in the log output.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import winston from "winston";

const LEVELS = {
  error: 0,
  warn: 1,
  success: 2,
  info: 3,
  http: 4,
  verbose: 5,
  debug: 6,
  silly: 7,
};

winston.addColors({
  error: "red",
  warn: "yellow",
  success: "green",
  info: "gray",
  http: "magenta",
  verbose: "blue",
  debug: "gray",
  silly: "purple",
});

// Manual ANSI coloring (instead of winston.format.colorize) so we can pad the level and module
// to fixed widths for aligned columns without ANSI escape codes throwing off the padding math.
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  error: "\x1b[31m",
  warn: "\x1b[33m",
  success: "\x1b[1;32m",
  info: "\x1b[90m",
  http: "\x1b[35m",
  verbose: "\x1b[34m",
  debug: "\x1b[90m",
  silly: "\x1b[35m",
} as const;

const devFormat = winston.format.combine(
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.printf(
    ({ timestamp, level, message, module, service, ...meta }) => {
      const color = (C as Record<string, string>)[level] ?? "";
      const lvl = `${color}${level.toUpperCase().padEnd(7)}${C.reset}`;
      const mod = module ? `${C.dim}${String(module).padStart(8)}${C.reset} ${C.dim}│${C.reset} ` : "";
      const metaStr = Object.keys(meta).length
        ? ` ${C.dim}${JSON.stringify(meta, null, 0)}${C.reset}`
        : "";
      // Embedded newlines in `message` (e.g. summary blocks) print unprefixed after line 1.
      return `${C.dim}${timestamp}${C.reset} ${lvl} ${mod}${message}${metaStr}`;
    },
  ),
);

/** Human-friendly elapsed time: 840ms, 4.2s, 2m 3s. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  levels: LEVELS,
  format: winston.format.json(),
  defaultMeta: { service: "agentic-migrator" },
  transports: [
    new winston.transports.Console({
      format:
        process.env.NODE_ENV === "production"
          ? winston.format.json()
          : devFormat,
    }),
  ],
  exceptionHandlers: [
    new winston.transports.Console({
      format: devFormat,
    }),
  ],
  rejectionHandlers: [
    new winston.transports.Console({
      format: devFormat,
    }),
  ],
  exitOnError: false,
});

// Lazily add JSONL file transport. Safe to call multiple times — no-op after first success.
export function ensureFileTransport(): void {
  const logFile = process.env.LOG_FILE;
  if (!logFile) return;
  // Check if a File transport is already added.
  if (logger.transports.some((t) => t instanceof winston.transports.File)) return;
  try {
    const abs = resolve(logFile);
    mkdirSync(dirname(abs), { recursive: true });
    const ft = new winston.transports.File({
      filename: abs,
      format: winston.format.json(),
    });
    logger.add(ft);
    // Also add to exception/rejection handlers so crash logs land in the file too.
    logger.exceptions.handle(ft);
    logger.rejections.handle(ft);
  } catch {
    // Directory not ready yet (Docker volume mount timing). Will retry on next call.
  }
}

// Try once at import — if the mount isn't ready yet, it silently skips.
ensureFileTransport();

// Augment winston Logger type so logger.success(...) compiles.
declare module "winston" {
  interface Logger {
    success: winston.LeveledLogMethod;
  }
}

export default logger;
