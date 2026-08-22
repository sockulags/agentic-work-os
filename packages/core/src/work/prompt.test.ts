import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ISSUE_BODY_MAX_CHARS, type RetainedItem, type WorkItem } from '@awos/protocol';
import { applyRetained, applyWorkItem, buildRetainedBlock, buildWorkItemBlock } from './prompt.js';

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

describe('buildRetainedBlock', () => {
  function kept(overrides: Partial<RetainedItem> = {}): RetainedItem {
    return {
      id: 'k1',
      workItemId: 'w1',
      kind: 'decision',
      text: 'Read GitHub through gh, never through a token of our own',
      runId: 'r1',
      threadId: 't1',
      source: 'claude',
      at: 1,
      selected: true,
      retired: false,
      ...overrides,
    };
  }

  test('nothing retained adds nothing to the prompt', () => {
    assert.equal(buildRetainedBlock([]), null);
  });

  test('groups by kind, so a decision does not read as an open question', () => {
    const block =
      buildRetainedBlock([
        kept(),
        kept({ id: 'k2', kind: 'question', text: 'Who owns the rate limit?' }),
        kept({ id: 'k3', kind: 'constraint', text: 'No network in tests' }),
        kept({ id: 'k4', kind: 'discovery', text: 'gh exits 1 for everything' }),
      ]) ?? '';

    assert.match(block, /^<retained-context>/);
    assert.match(block, /Decided:\n- Read GitHub through gh/);
    assert.match(block, /Constraints:\n- No network in tests/);
    assert.match(block, /Found out:\n- gh exits 1/);
    assert.match(block, /Still open:\n- Who owns the rate limit\?/);
  });

  test('says who established each line', () => {
    assert.match(buildRetainedBlock([kept()]) ?? '', /_\(claude\)_/);
  });

  test('tells the agent this is belief, not fact', () => {
    assert.match(buildRetainedBlock([kept()]) ?? '', /what was believed at the time/);
  });

  test('cuts an oversized ledger and says where the rest is', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      kept({ id: `k${i}`, text: `a decision long enough to matter, number ${i}` }),
    );

    const block = buildRetainedBlock(many) ?? '';
    assert.match(block, /cut here: retained context exceeded/);
    assert.match(block, /Work panel/);
  });
});

describe('applyRetained', () => {
  test('leaves the prompt alone when nothing was retained', () => {
    assert.equal(applyRetained(null, 'Do it.'), 'Do it.');
  });
});
