import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ISSUE_BODY_MAX_CHARS, type WorkItem } from '@awos/protocol';
import { applyWorkItem, buildWorkItemBlock } from './prompt.js';

function item(overrides: Partial<WorkItem['snapshot']> = {}): WorkItem {
  return {
    id: 'w1',
    workspaceRoot: '/repo',
    source: {
      repo: 'sockulags/agentic-work-os',
      number: 14,
      url: 'https://github.com/sockulags/agentic-work-os/issues/14',
    },
    snapshot: {
      title: 'Execute one GitHub issue as a work item',
      body: 'A thread currently begins with a folder.',
      state: 'OPEN',
      labels: ['enhancement'],
      author: 'sockulags',
      revision: '2026-08-22T19:26:05Z',
      ...overrides,
    },
    attachedAt: 1,
    fetchedAt: 1,
    lastRefreshedAt: 1,
  };
}

describe('buildWorkItemBlock', () => {
  test('a thread with no work item adds nothing to the prompt', () => {
    assert.equal(buildWorkItemBlock(null), null);
  });

  test('quotes the source rather than summarizing it', () => {
    const block = buildWorkItemBlock(item()) ?? '';

    assert.match(block, /^<work-item>/);
    assert.match(block, /<\/work-item>$/);
    assert.match(block, /sockulags\/agentic-work-os#14 \(OPEN\)/);
    assert.match(block, /issues\/14/);
    assert.match(block, /A thread currently begins with a folder\./);
    assert.match(block, /Labels: enhancement/);
  });

  test('names the revision it is quoting, so a run can say what it read', () => {
    assert.match(buildWorkItemBlock(item()) ?? '', /2026-08-22T19:26:05Z/);
  });

  test('cuts an oversized body and points at the full text', () => {
    const body = 'x'.repeat(ISSUE_BODY_MAX_CHARS + 500);
    const block = buildWorkItemBlock(item({ body })) ?? '';

    assert.match(block, /cut here: the issue body exceeded/);
    assert.match(block, /the full text is at https/);
    assert.ok(!block.includes(body), 'the tail past the budget must not be in the prompt');
  });

  test('says so when the issue has no description', () => {
    assert.match(buildWorkItemBlock(item({ body: '   ' })) ?? '', /no description/);
  });
});

describe('applyWorkItem', () => {
  test('goes ahead of the rest of the prompt', () => {
    assert.equal(applyWorkItem('<work-item>x</work-item>', 'Do it.'), '<work-item>x</work-item>\n\nDo it.');
  });

  test('leaves the prompt alone when there is no work item', () => {
    assert.equal(applyWorkItem(null, 'Do it.'), 'Do it.');
  });
});
