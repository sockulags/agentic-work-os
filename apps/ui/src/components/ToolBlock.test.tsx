import { describe, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TranscriptItem } from '@/lib/transcript';
import { ToolBlock } from './ToolBlock';

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
    render(<ToolBlock item={tool({ input: { command: 'git status' } })} />);

    expect(screen.getByText('git status')).toBeInTheDocument();
    expect(screen.queryByText('Input')).not.toBeInTheDocument();
  });

  test('expanding reveals the serialized input', () => {
    render(<ToolBlock item={tool({ input: { command: 'git status' } })} />);
    fireEvent.click(header());

    expect(screen.getByText('Input')).toBeInTheDocument();
    expect(screen.getByText(/"command": "git status"/)).toBeInTheDocument();
  });

  test('a null input has no Input section even when expanded', () => {
    render(<ToolBlock item={tool({ input: null })} />);
    fireEvent.click(header());

    expect(screen.queryByText('Input')).not.toBeInTheDocument();
  });
});

describe('ToolBlock status pill', () => {
  test('a running tool shows a spinner and no text', () => {
    const { container } = render(
      <ToolBlock item={tool({ status: 'running', exitCode: null })} />,
    );

    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  test('a clean success shows no exit code', () => {
    render(<ToolBlock item={tool({ status: 'ok', exitCode: 0 })} />);

    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  test('a success carrying a non-zero exit code still surfaces it', () => {
    render(<ToolBlock item={tool({ status: 'ok', exitCode: 3 })} />);

    expect(screen.getByText('3')).toBeInTheDocument();
  });

  test('a denied tool is labelled', () => {
    render(<ToolBlock item={tool({ status: 'denied', exitCode: null })} />);

    expect(screen.getByText('denied')).toBeInTheDocument();
  });

  test('an error with an exit code reads as exit N', () => {
    render(<ToolBlock item={tool({ status: 'error', exitCode: 1 })} />);

    expect(screen.getByText('exit 1')).toBeInTheDocument();
  });

  test('an error without an exit code falls back to the status name', () => {
    render(<ToolBlock item={tool({ status: 'aborted', exitCode: null })} />);

    expect(screen.getByText('aborted')).toBeInTheDocument();
  });
});

describe('ToolBlock output', () => {
  test('output is visible without expanding', () => {
    render(<ToolBlock item={tool({ output: 'hello world' })} />);

    expect(screen.getByText('hello world')).toBeInTheDocument();
  });

  test('truncates past 12 lines and offers the rest', () => {
    render(<ToolBlock item={tool({ output: numberedLines(20) })} />);

    expect(screen.getByText(/line 12/)).toBeInTheDocument();
    expect(screen.queryByText(/line 13/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show 8 more lines' }));

    expect(screen.getByText(/line 20/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more lines/ })).not.toBeInTheDocument();
  });

  test('exactly 12 lines is not truncated', () => {
    render(<ToolBlock item={tool({ output: numberedLines(12) })} />);

    expect(screen.queryByRole('button', { name: /more lines/ })).not.toBeInTheDocument();
  });

  test('an empty output renders nothing until expanded', () => {
    render(<ToolBlock item={tool({ output: '' })} />);
    expect(screen.queryByText('No output.')).not.toBeInTheDocument();

    fireEvent.click(header());
    expect(screen.getByText('No output.')).toBeInTheDocument();
  });

  test('an empty output on a running tool reads as running', () => {
    render(<ToolBlock item={tool({ output: '', status: 'running', exitCode: null })} />);
    fireEvent.click(header());

    expect(screen.getByText('Running…')).toBeInTheDocument();
  });
});

describe('ToolBlock diff detection', () => {
  test('unified-diff output renders through DiffView instead of a preview', () => {
    render(<ToolBlock item={tool({ output: PATCH })} />);

    expect(screen.getByRole('button', { name: 'Split' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unified' })).toBeInTheDocument();
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    // The diff path opts out of line truncation even though the patch is 14 lines.
    expect(screen.queryByRole('button', { name: /more lines/ })).not.toBeInTheDocument();
  });

  test('the diff stays collapsed until its own file header is clicked', () => {
    render(<ToolBlock item={tool({ output: PATCH })} />);

    expect(screen.queryByText('@@ -1,8 +1,8 @@')).not.toBeInTheDocument();

    // Expanding the tool does not open the file: DiffFileBlock seeds its open state once.
    fireEvent.click(header());
    expect(screen.queryByText('@@ -1,8 +1,8 @@')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts/ }));
    expect(screen.getByText('@@ -1,8 +1,8 @@')).toBeInTheDocument();
  });
});
