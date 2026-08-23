import { describe, expect, test } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { TranscriptItem } from '@/lib/transcript';
import { ToolBlock } from './ToolBlock';
import { renderWithDisplaySettings } from '@/test-harness';

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

const tool = (overrides: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool',
  id: 'tool-1',
  seq: 1,
  agent: 'claude',
  name: 'Bash',
  toolKind: 'command',
  title: 'git status',
  input: null,
  output: '',
  status: 'ok',
  exitCode: 0,
  ts: 1,
  ...overrides,
});

const numberedLines = (count: number): string =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

/** Enough context rows to push the patch past the 12-line truncation threshold. */
const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,8 +1,8 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' const c = 4;',
  ' const d = 5;',
  ' const e = 6;',
  ' const f = 7;',
  ' const g = 8;',
  ' const h = 9;',
].join('\n');

const header = (): HTMLElement => screen.getAllByRole('button')[0] as HTMLElement;

describe('ToolBlock header', () => {
  test('shows the tool title and stays collapsed', () => {
    renderWithDisplaySettings(<ToolBlock item={tool({ input: { command: 'git status' } })} />);

    expect(screen.getByText('git status')).toBeInTheDocument();
    expect(screen.queryByText('Input')).not.toBeInTheDocument();
  });

  test('expanding reveals the serialized input', () => {
    renderWithDisplaySettings(<ToolBlock item={tool({ input: { command: 'git status' } })} />);
    fireEvent.click(header());

    expect(screen.getByText('Input')).toBeInTheDocument();
    expect(screen.getByText(/"command": "git status"/)).toBeInTheDocument();
  });

  test('a null input has no Input section even when expanded', () => {
    renderWithDisplaySettings(<ToolBlock item={tool({ input: null })} />);
    fireEvent.click(header());

    expect(screen.queryByText('Input')).not.toBeInTheDocument();
  });
});

describe('ToolBlock status pill', () => {
  test('a running tool shows a spinner and its operational state', () => {
    const { container } = renderWithDisplaySettings(
      <ToolBlock item={tool({ status: 'running', exitCode: null })} />,
    );

    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  test('a clean success shows no exit code', () => {
    renderWithDisplaySettings(<ToolBlock item={tool({ status: 'ok', exitCode: 0 })} />);

    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  test('a success carrying a non-zero exit code still surfaces it', () => {
    renderWithDisplaySettings(<ToolBlock item={tool({ status: 'ok', exitCode: 3 })} />);

    expect(screen.getByText('exit 3')).toBeInTheDocument();
  });

  test('a denied tool is labelled', () => {
    renderWithDisplaySettings(<ToolBlock item={tool({ status: 'denied', exitCode: null })} />);

    expect(screen.getByText('Denied')).toBeInTheDocument();
  });

  test('an error with an exit code reads as exit N', () => {
    renderWithDisplaySettings(<ToolBlock item={tool({ status: 'error', exitCode: 1 })} />);

    // The one-line summary reports the exit code as well, so both are expected — what
    // this pins is that the status pill itself is not silent about a failure.
    expect(screen.getAllByText('exit 1').length).toBeGreaterThanOrEqual(1);
  });

  test('an error without an exit code falls back to the status name', () => {
    renderWithDisplaySettings(<ToolBlock item={tool({ status: 'aborted', exitCode: null })} />);

    expect(screen.getByText('Interrupted')).toBeInTheDocument();
  });
});

describe('ToolBlock output', () => {
  test('a successful tool keeps its output behind the header', () => {
    renderWithDisplaySettings(<ToolBlock item={tool({ output: 'hello world' })} />);

    expect(screen.queryByText('hello world')).not.toBeInTheDocument();

    fireEvent.click(header());
    expect(screen.getByText('hello world')).toBeInTheDocument();
  });

  // The counterpart to collapsing success: a failure the reader has to go looking for is
  // worse than the noise auto-collapse saves.
  test('a failing tool shows its output without being asked', () => {
    renderWithDisplaySettings(
      <ToolBlock item={tool({ output: 'boom', status: 'error', exitCode: 1 })} />,
    );

    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  test('truncates past 12 lines and offers the rest', () => {
    renderWithDisplaySettings(<ToolBlock item={tool({ output: numberedLines(20) })} />);
    fireEvent.click(header());

    expect(screen.getByText(/line 12/)).toBeInTheDocument();
    expect(screen.queryByText(/line 13/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show 8 more lines' }));

    expect(screen.getByText(/line 20/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more lines/ })).not.toBeInTheDocument();
  });

  test('exactly 12 lines is not truncated', () => {
    renderWithDisplaySettings(<ToolBlock item={tool({ output: numberedLines(12) })} />);
    fireEvent.click(header());

    expect(screen.queryByRole('button', { name: /more lines/ })).not.toBeInTheDocument();
  });

  test('an empty output renders nothing until expanded', () => {
    renderWithDisplaySettings(<ToolBlock item={tool({ output: '' })} />);
    expect(screen.queryByText('No output.')).not.toBeInTheDocument();

    fireEvent.click(header());
    expect(screen.getByText('No output.')).toBeInTheDocument();
  });

  test('an empty output on a running tool reads as running', () => {
    renderWithDisplaySettings(
      <ToolBlock item={tool({ output: '', status: 'running', exitCode: null })} />,
    );

    expect(screen.getByText('Running…')).toBeInTheDocument();
  });
});

describe('ToolBlock diff detection', () => {
  test('unified-diff output renders through DiffView instead of a preview', () => {
    renderWithDisplaySettings(<ToolBlock item={tool({ output: PATCH })} />);

    expect(screen.getByRole('button', { name: 'Split' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unified' })).toBeInTheDocument();
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    // The diff path opts out of line truncation even though the patch is 14 lines.
    expect(screen.queryByRole('button', { name: /more lines/ })).not.toBeInTheDocument();
  });

  // The deliberate exception to auto-collapse: a successful tool is folded away, but one
  // whose output is a diff arrives open, because the diff is the answer rather than the
  // machinery that produced it.
  test('a diff arrives open rather than folded away like other successful output', () => {
    renderWithDisplaySettings(<ToolBlock item={tool({ output: PATCH })} />);

    expect(screen.getByText('@@ -1,8 +1,8 @@')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts/ }));
    expect(screen.queryByText('@@ -1,8 +1,8 @@')).not.toBeInTheDocument();
  });
});
