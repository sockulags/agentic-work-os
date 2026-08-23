import { describe, expect, test } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { TranscriptItem } from '@/lib/transcript';
import { Transcript } from './Transcript';
import { idleRuntime, renderWithHarness } from '@/test-harness';

let seq = 0;
const next = (): number => (seq += 1);

const user = (text: string): TranscriptItem => ({
  kind: 'user',
  id: `u${next()}`,
  seq,
  text,
  ts: seq,
});

const message = (text: string, streaming = false): TranscriptItem => ({
  kind: 'message',
  id: `m${next()}`,
  seq,
  agent: 'claude',
  text,
  streaming,
  ts: seq,
});

const reasoning = (text: string, streaming = false): TranscriptItem => ({
  kind: 'reasoning',
  id: `r${next()}`,
  seq,
  agent: 'codex',
  text,
  streaming,
  ts: seq,
});

const divider = (agent: 'claude' | 'codex'): TranscriptItem => ({
  kind: 'divider',
  id: `d${next()}`,
  seq,
  agent,
  ts: seq,
});

const notice = (text: string, level: 'info' | 'error'): TranscriptItem => ({
  kind: 'notice',
  id: `n${next()}`,
  seq,
  level,
  text,
  ts: seq,
});

const toolCall = (title: string): TranscriptItem => ({
  kind: 'tool',
  id: `t${next()}`,
  seq,
  agent: 'claude',
  name: 'Bash',
  toolKind: 'command',
  title,
  input: null,
  output: 'done',
  status: 'ok',
  exitCode: 0,
  ts: seq,
});

describe('Transcript empty state', () => {
  test('explains agent switching instead of rendering an empty scroller', () => {
    renderWithHarness(<Transcript items={[]} />, { runtime: idleRuntime() });

    expect(screen.getByText(/Send a message to start/)).toBeInTheDocument();
  });

  test('the busy indicator is not shown before there is anything to say', () => {
    const { container } = renderWithHarness(<Transcript items={[]} />, { runtime: idleRuntime({ busyWith: 'claude' }) });

    expect(container.querySelectorAll('.animate-bounce')).toHaveLength(0);
  });
});

describe('Transcript item kinds', () => {
  test('a user message renders right-aligned in its own bubble', () => {
    const { container } = renderWithHarness(<Transcript items={[user('deploy it')]} />, { runtime: idleRuntime() });

    expect(screen.getByText('deploy it')).toBeInTheDocument();
    expect(container.querySelector('.justify-end')).not.toBeNull();
  });

  test('a divider names the agent taking the floor', () => {
    renderWithHarness(<Transcript items={[divider('codex'), divider('claude')]} />, { runtime: idleRuntime() });

    // Tie each label back to its agent's colour. Asserting the two labels merely exist
    // passes just as happily when the agent styles are swapped, which is the one thing
    // this row has to get right: it is the only marker of who is speaking.
    expect(screen.getByText('Codex')).toHaveClass('awos-worker-text');
    expect(screen.getByText('Claude')).toHaveClass('awos-worker-text');
    expect(screen.getByText('Codex').parentElement).toHaveClass('awos-worker');
    expect(screen.getByText('Claude').parentElement).toHaveClass('awos-worker');
  });

  test('an agent message renders as markdown, with a caret only while streaming', () => {
    const { container } = renderWithHarness(
      <Transcript items={[message('settled'), message('still going', true)]} />,
      { runtime: idleRuntime() },
    );

    expect(screen.getByText('settled')).toBeInTheDocument();
    expect(screen.getByText('still going')).toBeInTheDocument();

    // The caret is a CSS `::after` on the last block inside the streaming wrapper. jsdom
    // does not compute generated content, so the class that switches it on is the only
    // honest thing to assert here — that it lands on one message and not the other.
    expect(container.querySelectorAll('.awos-markdown-streaming')).toHaveLength(1);
    expect(screen.getByText('still going').closest('.awos-markdown-streaming')).not.toBeNull();
    expect(screen.getByText('settled').closest('.awos-markdown-streaming')).toBeNull();
  });

  test('settled reasoning is collapsed behind its duration label', () => {
    renderWithHarness(<Transcript items={[reasoning('secret chain of thought')]} />, {
      runtime: idleRuntime(),
    });

    expect(screen.queryByText('secret chain of thought')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Thought/ }));

    expect(screen.getByText('secret chain of thought')).toBeInTheDocument();
  });

  test('streaming reasoning gets an ellipsis on its label', () => {
    renderWithHarness(<Transcript items={[reasoning('partial', true)]} />, { runtime: idleRuntime() });

    expect(screen.getByRole('button', { name: 'Thinking…' })).toBeInTheDocument();
  });

  test('a tool call is delegated to ToolBlock', () => {
    renderWithHarness(<Transcript items={[toolCall('npm test')]} />, { runtime: idleRuntime() });

    // The delegation is what this pins, not the output: a successful tool is folded away
    // by ToolBlock, so its output is behind the header rather than on the page.
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.queryByText('done')).not.toBeInTheDocument();
  });

  test('an error notice is marked apart from an informational one', () => {
    renderWithHarness(
      <Transcript items={[notice('Interrupted.', 'info'), notice('spawn failed', 'error')]} />,
      { runtime: idleRuntime() },
    );

    // Both levels render the same text in the same place, so checking the text is present
    // holds even with the level branch inverted — and an error that reads as a routine
    // notice is exactly the regression worth catching.
    const info = screen.getByText('Interrupted.').parentElement as HTMLElement;
    const error = screen.getByText('spawn failed').parentElement as HTMLElement;

    expect(error).toHaveClass('border-state-failed-border');
    expect(info).not.toHaveClass('border-state-failed-border');
    expect(error.querySelector('.lucide-triangle-alert')).not.toBeNull();
    expect(info.querySelector('.lucide-info')).not.toBeNull();
  });
});

describe('Transcript composition', () => {
  test('items render in the order given', () => {
    const { container } = renderWithHarness(
      <Transcript items={[user('first'), message('second'), user('third')]} />,
      { runtime: idleRuntime() },
    );

    expect(container.textContent?.indexOf('first')).toBeLessThan(
      container.textContent?.indexOf('second') ?? -1,
    );
    expect(container.textContent?.indexOf('second')).toBeLessThan(
      container.textContent?.indexOf('third') ?? -1,
    );
  });

  test('busy appends the three-dot indicator after the last item', () => {
    const { container } = renderWithHarness(<Transcript items={[message('working on it')]} />, { runtime: idleRuntime({ busyWith: 'claude' }) });

    expect(container.querySelectorAll('.animate-bounce')).toHaveLength(3);
  });
});
