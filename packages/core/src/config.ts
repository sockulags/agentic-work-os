import { homedir } from 'node:os';
import { join } from 'node:path';

/** Fallback ceiling on a Codex turn when the config does not carry one. */
export const CODEX_TURN_TIMEOUT_DEFAULT_MS = 600_000;

/** Process-only name for the credential that authorizes human-owned records. */
export const HUMAN_AUTH_TOKEN_ENV = 'AWOS_HUMAN_AUTH_TOKEN';

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
  /** Qwen Code local OpenAI-compatible target. Optional for injected legacy test configs. */
  qwenBaseUrl?: string;
  qwenModel?: string;
  qwenApiKey?: string;
  qwenBin?: string;
  qwenTurnTimeoutMs?: number;
  /** Distinct credential for human answer and attestation writes. Never given to workers. */
  humanAuthorityToken?: string;
  /** WebSocket bind. Port 0 asks the OS for a free one. */
  host: string;
  port: number;
  /** Replay budget. See ARCHITECTURE.md §4. */
  replayMaxChars: number;
  replayMaxToolOutput: number;
  /**
   * Fallback setup command for lanes in a directory that declares no workspace.
   *
   * A lane is a git worktree, so it holds the source but not what git ignores — for most
   * repos that means no `node_modules`, and an agent that cannot run the tests. What makes
   * a lane usable is project knowledge, which is why it now belongs in the project's own
   * `.awos/workspace.json`. This variable predates that file and still works where there
   * is none, but a project that declares `setup.command` wins over it: the repository is
   * the authority on how it installs, and a stale export in a shell is not.
   */
  laneSetup: string;
  /** How long that command may run when the workspace does not say. */
  laneSetupTimeoutMs: number;
  /** How long to wait for a graceful interrupt before SIGTERM. */
  interruptGraceMs: number;
  /** How long an approval may sit unanswered before it auto-denies. */
  approvalTimeoutMs: number;
  /** Startup handshake budget for `codex app-server`. */
  codexInitTimeoutMs: number;
  /**
   * Ceiling on one Codex turn, measured from `turn/start` to `turn/completed`.
   *
   * `turn/start` only acknowledges that the turn was accepted; what ends it is a
   * notification that arrives later. If that notification never comes — the server exits,
   * or renames the method the adapter matches on — the thread would otherwise stay busy
   * forever with no error. Optional so injected legacy test configs still typecheck.
   */
  codexTurnTimeoutMs?: number;
  /**
   * The GitHub CLI, used to read work items as the user.
   *
   * A binary rather than an API token on purpose: `gh` is already authenticated, so the
   * harness never holds a credential of its own. Overridable for the same reasons the
   * agent binaries are — a wrapper, a different install, or a fake in the tests.
   */
  ghBin: string;
  ghBinArgs: string[];
  /** How long a single `gh` call may take before it counts as unreachable. */
  ghTimeoutMs: number;
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
    qwenBaseUrl: envStr('AWOS_QWEN_BASE_URL', 'http://127.0.0.1:1234/v1'),
    qwenModel: envStr('AWOS_QWEN_MODEL', 'qwen3.8-27b-local'),
    qwenApiKey: envStr('AWOS_QWEN_API_KEY', 'local-placeholder'),
    qwenBin: envStr('AWOS_QWEN_BIN', ''),
    qwenTurnTimeoutMs: envInt('AWOS_QWEN_TURN_TIMEOUT_MS', 600_000),
    humanAuthorityToken: process.env[HUMAN_AUTH_TOKEN_ENV] || undefined,
    host: envStr('AWOS_HOST', '127.0.0.1'),
    port: envInt('AWOS_PORT', 4319),
    replayMaxChars: envInt('AWOS_REPLAY_MAX_CHARS', 24_000),
    replayMaxToolOutput: envInt('AWOS_REPLAY_MAX_TOOL_OUTPUT', 800),
    laneSetup: envStr('AWOS_LANE_SETUP', ''),
    laneSetupTimeoutMs: envInt('AWOS_LANE_SETUP_TIMEOUT_MS', 10 * 60_000),
    interruptGraceMs: envInt('AWOS_INTERRUPT_GRACE_MS', 4_000),
    approvalTimeoutMs: envInt('AWOS_APPROVAL_TIMEOUT_MS', 10 * 60_000),
    codexInitTimeoutMs: envInt('AWOS_CODEX_INIT_TIMEOUT_MS', 30_000),
    codexTurnTimeoutMs: envInt('AWOS_CODEX_TURN_TIMEOUT_MS', CODEX_TURN_TIMEOUT_DEFAULT_MS),
    ghBin: envStr('AWOS_GH_BIN', 'gh'),
    ghBinArgs: envArgs('AWOS_GH_BIN_ARGS'),
    ghTimeoutMs: envInt('AWOS_GH_TIMEOUT_MS', 20_000),
  };
}
