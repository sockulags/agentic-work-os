import { describe, expect, test } from 'vitest';
import { getAgentStyle } from './AgentBadge';

describe('profile-provided worker identity', () => {
  test('derives one stable generic style for any profile id', () => {
    const first = getAgentStyle('future-worker', 'Future Worker');
    const second = getAgentStyle('future-worker', 'Future Worker');

    expect(first).toEqual(second);
    expect(first.label).toBe('Future Worker');
    expect(first.root).toBe('awos-worker');
    expect(first.text).toBe('awos-worker-text');
    expect(first.cssVars['--worker-hue']).toMatch(/^\d+$/);
  });

  test('keeps a readable fallback label without a profile-specific branch', () => {
    expect(getAgentStyle('qwen-local').label).toBe('Qwen Local');
  });
});
