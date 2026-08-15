import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/**
 * Cross-platform CLI spawning.
 *
 * Both `claude` and `codex` install as `.cmd` shims on Windows, and since Node 18.20
 * `spawn` refuses to execute `.cmd` without a shell. Using `shell: true` fixes that but
 * hands argument parsing to cmd.exe, so every argument has to be quoted defensively —
 * our args include inline JSON (`--mcp-config`) full of quotes and braces, which cmd.exe
 * would otherwise mangle.
 *
 * The rest of the codebase spawns through here so that platform quirk lives in one file.
 */

export type StdioChild = ChildProcessByStdio<Writable, Readable, Readable>;

export interface SpawnCliOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Quote one argument for cmd.exe.
 *
 * cmd.exe escaping is genuinely awkward: a literal `"` must become `\"`, trailing
 * backslashes before the closing quote must be doubled, and the shell metacharacters
 * `& | < > ^` need a caret escape even inside quotes.
 */
function quoteForCmd(arg: string): string {
  if (arg.length > 0 && !/[\s"&|<>^%]/.test(arg)) return arg;

  // Double any run of backslashes that precedes a quote, and escape the quote itself.
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  // Double a trailing run of backslashes so it doesn't escape our closing quote.
  escaped = escaped.replace(/(\\*)$/, '$1$1');
  return `"${escaped}"`;
}

export function spawnCli(
  command: string,
  args: string[],
  options: SpawnCliOptions,
): StdioChild {
  const isWindows = process.platform === 'win32';

  const env = { ...process.env, ...options.env };

  if (!isWindows) {
    return spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as StdioChild;
  }

  const line = [command, ...args].map(quoteForCmd).join(' ');
  return spawn(line, {
    cwd: options.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    windowsHide: true,
  }) as StdioChild;
}

/** Run a command to completion and capture stdout. Used for availability probes. */
export async function runCapture(
  command: string,
  args: string[],
  timeoutMs = 5_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child: StdioChild;
    try {
      child = spawnCli(command, args, { cwd: process.cwd() });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: (err as Error).message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.on('error', (err) => {
      stderr += err.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
