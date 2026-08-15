import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Every tunable in one place, all overridable by env so you can tune a running
 * install without a rebuild.
 */
export interface HarnessConfig {
  /** Where threads and transcripts live. */
  dataDir: string;
  /** Executable for each agent — override when they aren't on PATH. */
  claudeBin: string;
  codexBin: string;
  /**
   * Arguments injected before the harness's own, as a JSON array.
   *
   * Lets you put the agent behind a wrapper — `wsl`, a corporate process launcher, a
   * `node` invocation of a stand-in binary — without the adapter knowing. The
   * integration tests use this to point at the fake CLIs.
   */
  claudeBinArgs: string[];
  codexBinArgs: string[];
  /** Default model per agent; empty string means "let the CLI decide". */
  claudeModel: string;
  codexModel: string;
  /** WebSocket bind. Port 0 asks the OS for a free one. */
  host: string;
  port: number;
  /** Replay budget. See ARCHITECTURE.md §4. */
  replayMaxChars: number;
  replayMaxToolOutput: number;
  /** How long to wait for a graceful interrupt before SIGTERM. */
  interruptGraceMs: number;
  /** How long an approval may sit unanswered before it auto-denies. */
  approvalTimeoutMs: number;
  /** Startup handshake budget for `codex app-server`. */
  codexInitTimeoutMs: number;
}

function envStr(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envArgs(key: string): string[] {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function loadConfig(): HarnessConfig {
  return {
    dataDir: envStr('AWOS_DATA_DIR', join(homedir(), '.awos')),
    claudeBin: envStr('AWOS_CLAUDE_BIN', 'claude'),
    codexBin: envStr('AWOS_CODEX_BIN', 'codex'),
    claudeBinArgs: envArgs('AWOS_CLAUDE_BIN_ARGS'),
    codexBinArgs: envArgs('AWOS_CODEX_BIN_ARGS'),
    claudeModel: envStr('AWOS_CLAUDE_MODEL', ''),
    codexModel: envStr('AWOS_CODEX_MODEL', ''),
    host: envStr('AWOS_HOST', '127.0.0.1'),
    port: envInt('AWOS_PORT', 4319),
    replayMaxChars: envInt('AWOS_REPLAY_MAX_CHARS', 24_000),
    replayMaxToolOutput: envInt('AWOS_REPLAY_MAX_TOOL_OUTPUT', 800),
    interruptGraceMs: envInt('AWOS_INTERRUPT_GRACE_MS', 4_000),
    approvalTimeoutMs: envInt('AWOS_APPROVAL_TIMEOUT_MS', 10 * 60_000),
    codexInitTimeoutMs: envInt('AWOS_CODEX_INIT_TIMEOUT_MS', 30_000),
  };
}
