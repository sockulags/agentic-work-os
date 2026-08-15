/**
 * Logging goes to stderr, never stdout.
 *
 * This is not stylistic: the permission MCP server owns stdout as a protocol channel,
 * and a stray console.log there corrupts the JSON-RPC stream in a way that surfaces as a
 * baffling agent-side error. Keeping every logger on stderr makes that class of bug
 * impossible rather than merely unlikely.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function activeLevel(): LogLevel {
  const raw = (process.env['AWOS_LOG_LEVEL'] ?? 'info').toLowerCase();
  return raw in LEVEL_ORDER ? (raw as LogLevel) : 'info';
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  const emit = (level: LogLevel, msg: string, meta?: unknown): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    if (meta === undefined) {
      process.stderr.write(`${line}\n`);
    } else {
      process.stderr.write(`${line} ${safeStringify(meta)}\n`);
    }
  };

  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  } catch {
    return String(value);
  }
}
