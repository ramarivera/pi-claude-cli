/**
 * Lightweight, zero-dependency debug logger.
 *
 * Off by default. Enable by setting PI_CLAUDE_CLI_DEBUG to a truthy value, e.g.
 *   PI_CLAUDE_CLI_DEBUG=1 pi ...
 *
 * When enabled, structured events are appended as pino-compatible NDJSON to
 *   <home>/.pi-claude-cli/logs/pi-claude-cli-<pid>.ndjson
 * so the output can be piped through `pino-pretty` if desired. Logging never
 * throws — diagnostics must never take down the provider.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ENABLED = (() => {
  const v = process.env.PI_CLAUDE_CLI_DEBUG;
  return v != null && v !== "" && v !== "0" && v.toLowerCase() !== "false";
})();

let resolvedPath: string | undefined;
let pathResolveFailed = false;

/** Resolve (and lazily create) the log file path, or undefined if unavailable. */
function getLogPath(): string | undefined {
  if (!ENABLED || pathResolveFailed) return undefined;
  if (resolvedPath) return resolvedPath;
  try {
    const dir = join(homedir(), ".pi-claude-cli", "logs");
    mkdirSync(dir, { recursive: true });
    resolvedPath = join(dir, `pi-claude-cli-${process.pid}.ndjson`);
    return resolvedPath;
  } catch {
    // Could not create the log dir — disable further attempts.
    pathResolveFailed = true;
    return undefined;
  }
}

/** True when debug logging is active (cheap guard for callers building payloads). */
export function isDebugLoggingEnabled(): boolean {
  return ENABLED;
}

/**
 * Append a structured debug event. No-op unless PI_CLAUDE_CLI_DEBUG is set.
 *
 * @param msg - Short event name (becomes the pino `msg` field)
 * @param data - Optional structured fields merged into the log line
 */
export function debugLog(msg: string, data?: Record<string, unknown>): void {
  if (!ENABLED) return;
  const path = getLogPath();
  if (!path) return;
  try {
    const line = JSON.stringify({
      level: 30,
      time: Date.now(),
      pid: process.pid,
      name: "pi-claude-cli",
      msg,
      ...data,
    });
    appendFileSync(path, line + "\n");
  } catch {
    // Never let logging break the provider.
  }
}
