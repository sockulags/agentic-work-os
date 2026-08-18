import { describe, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TranscriptItem } from '@/lib/transcript';
import { Transcript } from './Transcript';

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
    render(<Transcript items={[]} busy={false} />);

    expect(screen.getByText(/Send a message to start/)).toBeInTheDocument();
  });

  test('the busy indicator is not shown before there is anything to say', () => {
    const { container } = render(<Transcript items={[]} busy />);

    expect(container.querySelectorAll('.animate-bounce')).toHaveLength(0);
  });
});

describe('Transcript item kinds', () => {
  test('a user message renders right-aligned in its own bubble', () => {
    const { container } = render(<Transcript items={[user('deploy it')]} busy={false} />);

    expect(screen.getByText('deploy it')).toBeInTheDocument();
    expect(container.querySelector('.justify-end')).not.toBeNull();
  });

  test('a divider names the agent taking the floor', () => {
    render(<Transcript items={[divider('codex'), divider('claude')]} busy={false} />);

    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
  });

  test('an agent message renders as plain text, with a caret only while streaming', () => {
    const { container } = render(
      <Transcript items={[message('settled'), message('still going', true)]} busy={false} />,
    );

    expect(screen.getByText('settled')).toBeInTheDocument();
    expect(screen.getByText('still going')).toHaveClass('awos-caret');
    expect(screen.getByText('settled')).not.toHaveClass('awos-caret');
    expect(container.querySelectorAll('.awos-caret')).toHaveLength(1);
  });

  test('reasoning is collapsed behind a Thinking toggle', () => {
    render(<Transcript items={[reasoning('secret chain of thought')]} busy={false} />);

    expect(screen.queryByText('secret chain of thought')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Thinking/ }));

    expect(screen.getByText('secret chain of thought')).toBeInTheDocument();
  });

  test('streaming reasoning gets an ellipsis on its label', () => {
    render(<Transcript items={[reasoning('partial', true)]} busy={false} />);

    expect(screen.getByRole('button', { name: 'Thinking…' })).toBeInTheDocument();
  });

  test('a tool call is delegated to ToolBlock', () => {
    render(<Transcript items={[toolCall('npm test')]} busy={false} />);

    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getByText('done')).toBeInTheDocument();
  });

  test('notices render at both levels', () => {
    render(
      <Transcript
        items={[notice('Interrupted.', 'info'), notice('spawn failed', 'error')]}
        busy={false}
      />,
    );

    expect(screen.getByText('Interrupted.')).toBeInTheDocument();
    expect(screen.getByText('spawn failed')).toBeInTheDocument();
  });
});

describe('Transcript composition', () => {
  test('items render in the order given', () => {
    const { container } = render(
      <Transcript items={[user('first'), message('second'), user('third')]} busy={false} />,
    );

    expect(container.textContent?.indexOf('first')).toBeLessThan(
      container.textContent?.indexOf('second') ?? -1,
    );
    expect(container.textContent?.indexOf('second')).toBeLessThan(
      container.textContent?.indexOf('third') ?? -1,
    );
  });

  test('busy appends the three-dot indicator after the last item', () => {
    const { container } = render(<Transcript items={[message('working on it')]} busy />);

    expect(container.querySelectorAll('.animate-bounce')).toHaveLength(3);
  });
});
