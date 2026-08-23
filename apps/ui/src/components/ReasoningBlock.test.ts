import { describe, test, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import { formatThinkingLabel, reasoningVisibility, ReasoningBlock } from './ReasoningBlock';
import { renderWithDisplaySettings } from '@/test-harness';

/**
 * The two decisions the reasoning line makes — whether to show at all, and what to call
 * itself — live outside the component so they can be pinned without a DOM. The rendering
 * around them is a button and a `<pre>`.
 */

describe('reasoningVisibility', () => {
  test('compact keeps reasoning available behind the disclosure control', () => {
    expect(reasoningVisibility('compact')).toBe('collapsed');
  });

  test('normal keeps it, folded away', () => {
    expect(reasoningVisibility('normal')).toBe('collapsed');
  });

  test('verbose opens it', () => {
    expect(reasoningVisibility('verbose')).toBe('expanded');
  });
});

describe('formatThinkingLabel', () => {
  test('says nothing about duration when none was measured', () => {
    // A thread replayed after a reload has a completed block that never streamed here,
    // so there is no honest number to show.
    expect(formatThinkingLabel(null)).toBe('Thought');
  });

  test('does not round a sub-second thought down to zero', () => {
    expect(formatThinkingLabel(0)).toBe('Thought for <1s');
    expect(formatThinkingLabel(940)).toBe('Thought for <1s');
  });

  test('reports whole seconds under a minute', () => {
    expect(formatThinkingLabel(1000)).toBe('Thought for 1s');
    expect(formatThinkingLabel(4200)).toBe('Thought for 4s');
    expect(formatThinkingLabel(59_000)).toBe('Thought for 59s');
  });

  test('breaks into minutes above that', () => {
    expect(formatThinkingLabel(60_000)).toBe('Thought for 1m 0s');
    expect(formatThinkingLabel(95_400)).toBe('Thought for 1m 35s');
  });
});

describe('ReasoningBlock density presentation', () => {
  afterEach(() => window.localStorage.removeItem('awos:density'));

  test('compact and comfortable modes keep the same reasoning content available', () => {
    window.localStorage.setItem('awos:density', 'compact');
    const compact = renderWithDisplaySettings(
      createElement(ReasoningBlock, { text: 'recorded reasoning', streaming: false, startedAt: 1, settled: true }),
    );
    expect(screen.queryByText('recorded reasoning')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Thought/ }));
    expect(screen.getByText('recorded reasoning')).toBeInTheDocument();
    compact.unmount();

    window.localStorage.setItem('awos:density', 'verbose');
    renderWithDisplaySettings(
      createElement(ReasoningBlock, { text: 'recorded reasoning', streaming: false, startedAt: 1, settled: true }),
    );
    expect(screen.getByText('recorded reasoning')).toBeInTheDocument();
  });
});
