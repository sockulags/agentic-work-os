import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EvidenceItem } from '@awos/protocol';
import { evaluateGate, explainGate } from './gate.js';

const VERIFY = [
  { name: 'test', command: 'npm test' },
  { name: 'typecheck', command: 'npm run typecheck' },
];

const CANDIDATE = 'tree-of-the-lane';

let at = 0;

function result(overrides: Partial<EvidenceItem> & { check?: EvidenceItem['check'] } = {}): EvidenceItem {
  at += 1;
  return {
    id: `ev${at}`,
    runId: 'r1',
    workItemId: 'w1',
    threadId: 't1',
    kind: 'command',
    ref: { eventId: null, url: null, label: 'npm test' },
    summary: 'passed',
    state: { commit: 'c1', tree: CANDIDATE, dirty: false },
    check: { name: 'test', passed: true, exitCode: 0 },
    source: 'user',
    at,
    ...overrides,
  };
}

function gate(evidence: EvidenceItem[], requires = ['test'], candidateTree: string | null = CANDIDATE) {
  return evaluateGate({
    integration: { requires, allowOverride: false },
    verify: VERIFY,
    evidence,
    candidateTree,
  });
}

describe('evaluateGate', () => {
  test('a project that requires nothing gates nothing', () => {
    const decision = gate([], []);

    assert.equal(decision.allowed, true);
    assert.deepEqual(decision.requirements, []);
  });

  test('a check nobody ran is missing, and that blocks', () => {
    const decision = gate([]);

    assert.equal(decision.allowed, false);
    assert.equal(decision.requirements[0]?.state, 'missing');
    assert.equal(decision.requirements[0]?.command, 'npm test', 'says what it would run');
    assert.equal(decision.requirements[0]?.evidenceId, null);
  });

  test('a check that passed against this exact tree is satisfied', () => {
    const decision = gate([result()]);

    assert.equal(decision.allowed, true);
    assert.equal(decision.requirements[0]?.state, 'satisfied');
    assert.equal(decision.requirements[0]?.evidenceId, 'ev1');
  });

  test('a check that failed blocks, and says which evidence decided it', () => {
    const decision = gate([result({ check: { name: 'test', passed: false, exitCode: 1 } })]);

    assert.equal(decision.allowed, false);
    assert.equal(decision.requirements[0]?.state, 'failed');
    assert.equal(decision.requirements[0]?.evidenceId, decision.requirements[0]?.evidenceId);
  });

  test('a pass against different content is stale, which is the case instructions cannot catch', () => {
    const decision = gate([
      result({ state: { commit: 'c0', tree: 'an-older-tree', dirty: false } }),
    ]);

    assert.equal(decision.allowed, false);
    assert.equal(decision.requirements[0]?.state, 'stale');
    assert.equal(decision.requirements[0]?.evidenceTree, 'an-older-tree');
  });

  test('a candidate with no tree cannot be shown to have been verified', () => {
    const decision = gate([result()], ['test'], null);

    assert.equal(decision.allowed, false);
    assert.equal(decision.requirements[0]?.state, 'stale');
  });

  describe('the latest result decides', () => {
    test('a failure that was fixed does not veto forever', () => {
      const decision = gate([
        result({ check: { name: 'test', passed: false, exitCode: 1 } }),
        result({ check: { name: 'test', passed: true, exitCode: 0 } }),
      ]);

      assert.equal(decision.requirements[0]?.state, 'satisfied');
    });

    test('a pass that was later broken does not stand', () => {
      const decision = gate([
        result({ check: { name: 'test', passed: true, exitCode: 0 } }),
        result({ check: { name: 'test', passed: false, exitCode: 1 } }),
      ]);

      assert.equal(decision.requirements[0]?.state, 'failed');
    });
  });

  test('evidence for another check does not satisfy this one', () => {
    const decision = gate([result({ check: { name: 'lint', passed: true, exitCode: 0 } })]);

    assert.equal(decision.requirements[0]?.state, 'missing');
  });

  test('evidence that is not a check result satisfies nothing', () => {
    const decision = gate([result({ check: null, kind: 'link' })]);

    assert.equal(decision.requirements[0]?.state, 'missing');
  });

  test('every requirement has to hold, and all of them are reported', () => {
    const decision = gate([result()], ['test', 'typecheck']);

    assert.equal(decision.allowed, false);
    assert.deepEqual(
      decision.requirements.map((entry) => [entry.name, entry.state]),
      [
        ['test', 'satisfied'],
        ['typecheck', 'missing'],
      ],
    );
  });
});

describe('explainGate', () => {
  test('names what is unsatisfied and why', () => {
    const decision = gate(
      [result({ state: { commit: 'c0', tree: 'older', dirty: false } })],
      ['test', 'typecheck'],
    );

    const explanation = explainGate(decision);
    assert.match(explanation, /test passed against different content/);
    assert.match(explanation, /typecheck has not been run/);
  });

  test('says so when everything holds', () => {
    assert.match(explainGate(gate([result()])), /every required check passed/);
  });
});
