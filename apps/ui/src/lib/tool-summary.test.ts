import { describe, test, expect } from 'vitest';
import {
  countChurn,
  countLines,
  formatToolSummary,
  shortenPath,
  shouldExpandTool,
  summarizeTool,
  type ToolSummarySource,
} from './tool-summary';

/**
 * These strings are the transcript's whole vocabulary for tool calls — get one wrong and
 * the reader is back to parsing raw titles. They are also the only part of this unit
 * that is pure, so this is where the coverage belongs.
 */

function tool(overrides: Partial<ToolSummarySource> = {}): ToolSummarySource {
  return {
    toolKind: 'other',
    name: 'Wrench',
    title: 'something',
    input: null,
    output: '',
    status: 'ok',
    exitCode: null,
    ...overrides,
  };
}

describe('summarizeTool — commands', () => {
  test('shows the command line and the exit code when one was reported', () => {
    expect(
      formatToolSummary(
        tool({
          toolKind: 'command',
          name: 'Bash',
          title: 'npm test',
          input: { command: 'npm test' },
          output: 'ok\n',
          exitCode: 0,
        }),
      ),
    ).toBe('npm test · exit 0');
  });

  test('falls back to output size when the agent reports no exit code', () => {
    expect(
      formatToolSummary(
        tool({
          toolKind: 'command',
          name: 'Bash',
          title: 'ls',
          input: { command: 'ls' },
          output: 'a\nb\nc\n',
        }),
      ),
    ).toBe('ls · 3 lines');
  });

  test('joins a Codex argv array into one command line', () => {
    expect(
      summarizeTool(
        tool({ toolKind: 'command', name: 'command_execution', input: { command: ['git', 'status'] } }),
      ).label,
    ).toBe('git status');
  });

  test('flattens a multi-line command so the row stays one line', () => {
    expect(
      summarizeTool(tool({ toolKind: 'command', input: { command: 'cat <<EOF\nhello\nEOF' } })).label,
    ).toBe('cat <<EOF hello EOF');
  });

  test('says nothing about size while the command is still running', () => {
    expect(
      summarizeTool(tool({ toolKind: 'command', input: { command: 'ls' }, output: 'a\n', status: 'running' }))
        .facts,
    ).toEqual([]);
  });
});

describe('summarizeTool — files', () => {
  test('names the file read and how much came back', () => {
    expect(
      formatToolSummary(
        tool({
          toolKind: 'file_read',
          name: 'Read',
          title: 'Read /home/me/proj/src/foo.ts',
          input: { file_path: 'src/foo.ts' },
          output: Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n'),
        }),
      ),
    ).toBe('Read src/foo.ts · 120 lines');
  });

  test('reports churn when an edit answered with a patch', () => {
    const patch = ['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1,2 @@', '-old', '+new', '+extra'].join('\n');
    expect(
      formatToolSummary(
        tool({ toolKind: 'file_edit', name: 'Edit', input: { file_path: 'x.ts' }, output: patch }),
      ),
    ).toBe('Edited x.ts · +2 -1');
  });

  test('uses the write verb for Write', () => {
    expect(
      summarizeTool(tool({ toolKind: 'file_edit', name: 'Write', input: { file_path: 'new.ts' } })).label,
    ).toBe('Wrote new.ts');
  });

  test('counts files when Codex changed several at once', () => {
    expect(
      summarizeTool(
        tool({
          toolKind: 'file_edit',
          name: 'file_change',
          input: { changes: [{ path: 'a.ts' }, { path: 'b.ts' }] },
        }),
      ).label,
    ).toBe('Edited 2 files');
  });

  test('falls back to the raw title when no path is anywhere in the input', () => {
    expect(
      summarizeTool(tool({ toolKind: 'file_read', name: 'Read', title: 'Read a file', input: {} })).label,
    ).toBe('Read a file');
  });
});

describe('summarizeTool — search, web, task, todo, mcp', () => {
  test('quotes the pattern and counts matches', () => {
    expect(
      formatToolSummary(
        tool({
          toolKind: 'search',
          name: 'Grep',
          input: { pattern: 'useHarness' },
          output: Array.from({ length: 7 }, (_, i) => `hit ${i}`).join('\n'),
        }),
      ),
    ).toBe('Searched "useHarness" · 7 matches');
  });

  test('counts files rather than matches for Glob', () => {
    expect(
      summarizeTool(tool({ toolKind: 'search', name: 'Glob', input: { pattern: '*.ts' }, output: 'a.ts' }))
        .facts,
    ).toEqual(['1 file']);
  });

  test('reduces a fetched URL to its host', () => {
    expect(
      summarizeTool(tool({ toolKind: 'web', name: 'WebFetch', input: { url: 'https://example.com/a/b?c=1' } }))
        .label,
    ).toBe('Fetched example.com');
  });

  test('reads a web search as a question', () => {
    expect(
      summarizeTool(tool({ toolKind: 'web', name: 'WebSearch', input: { query: 'tailwind v4' } })).label,
    ).toBe('Searched the web for "tailwind v4"');
  });

  test('marks a subagent call as delegated work', () => {
    expect(
      summarizeTool(tool({ toolKind: 'task', name: 'Task', input: { description: 'find the leak' } })).label,
    ).toBe('Subagent: find the leak');
  });

  test('counts the todos in a plan update', () => {
    expect(
      formatToolSummary(
        tool({ toolKind: 'todo', name: 'TodoWrite', input: { todos: [{}, {}, {}] } }),
      ),
    ).toBe('Updated the plan · 3 items');
  });

  test('splits an MCP tool name into tool and server', () => {
    expect(
      summarizeTool(tool({ toolKind: 'mcp', name: 'mcp__supabase__execute_sql', title: 'x' })).label,
    ).toBe('execute_sql via supabase');
  });
});

describe('shouldExpandTool', () => {
  const ok = tool({ toolKind: 'command', input: { command: 'ls' }, output: 'a', status: 'ok' });

  test('collapses a call that succeeded', () => {
    expect(shouldExpandTool(ok, 'normal')).toBe(false);
  });

  test('keeps a failure open at every density', () => {
    const failed = { ...ok, status: 'error' as const };
    expect(shouldExpandTool(failed, 'normal')).toBe(true);
    expect(shouldExpandTool(failed, 'compact')).toBe(true);
  });

  test('keeps a denial open — it is a decision the reader made', () => {
    expect(shouldExpandTool({ ...ok, status: 'denied' }, 'normal')).toBe(true);
  });

  test('follows a running call, unless the reader asked for compact', () => {
    const running = { ...ok, status: 'running' as const };
    expect(shouldExpandTool(running, 'normal')).toBe(true);
    expect(shouldExpandTool(running, 'compact')).toBe(false);
  });

  test('keeps diff output open — it is the answer, not the bookkeeping', () => {
    const patch = ['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n');
    expect(shouldExpandTool({ ...ok, output: patch }, 'normal')).toBe(true);
    expect(shouldExpandTool({ ...ok, output: patch }, 'compact')).toBe(false);
  });

  test('opens everything in verbose', () => {
    expect(shouldExpandTool(ok, 'verbose')).toBe(true);
  });
});

describe('helpers', () => {
  test('countLines ignores trailing newlines', () => {
    expect(countLines('a\nb\n\n')).toBe(2);
    expect(countLines('')).toBe(0);
  });

  test('countChurn ignores the file headers', () => {
    expect(countChurn('--- a\n+++ b\n+x\n-y\n z')).toBe('+1 -1');
    expect(countChurn('plain output')).toBe(null);
  });

  test('shortenPath keeps the tail that identifies the file', () => {
    expect(shortenPath('src/foo.ts')).toBe('src/foo.ts');
    expect(shortenPath('C:\\Users\\me\\Code\\proj\\apps\\ui\\src\\lib\\tool-summary.ts')).toBe(
      '…/src/lib/tool-summary.ts',
    );
  });
});
