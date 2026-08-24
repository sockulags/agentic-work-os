import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { WORKSPACE_NOTES_MAX_CHARS, type EffectiveWorkspace, type WorkspaceResolution } from '@awos/protocol';
import { applyWorkspace, buildWorkspaceBlock } from './prompt.js';

function workspace(overrides: Partial<EffectiveWorkspace> = {}): WorkspaceResolution {
  return {
    status: 'ok',
    problems: [],
    workspace: {
      root: '/repo',
      name: 'agentic-work-os',
      repository: { root: '.', github: 'sockulags/agentic-work-os' },
      agents: ['claude', 'codex'],
      setup: { command: 'npm install', timeoutMs: null },
      verify: [{ name: 'test', command: 'npm test' }],
      integration: { requires: [], allowOverride: false },
      context: { references: ['ARCHITECTURE.md'], notes: '' },
      roles: [],
      steps: [],
      routes: [],
      guardrails: [],
      origins: {
        name: 'shared',
        repository: 'shared',
        agents: 'shared',
        setup: 'shared',
        verify: 'shared',
        integration: 'default',
        context: 'shared',
        roles: 'default',
        steps: 'default',
        routes: 'default',
        guardrails: 'default',
      },
      sources: ['.awos/workspace.json'],
      ...overrides,
    },
  };
}

describe('buildWorkspaceBlock', () => {
  test('an undeclared directory adds nothing to the prompt', () => {
    assert.equal(buildWorkspaceBlock({ status: 'none', searchedFrom: '/tmp' }), null);
  });

  test('carries the project settings an agent would otherwise have to ask for', () => {
    const block = buildWorkspaceBlock(workspace()) ?? '';

    assert.match(block, /^<workspace>/);
    assert.match(block, /<\/workspace>$/);
    assert.match(block, /Workspace: agentic-work-os/);
    assert.match(block, /GitHub: sockulags\/agentic-work-os/);
    assert.match(block, /Agents allowed here: claude, codex/);
    assert.match(block, /npm install/);
    assert.match(block, /test — npm test/);
    assert.match(block, /ARCHITECTURE\.md/);
  });

  test('carries effective guardrail ids and stable references without evaluator internals', () => {
    const block = buildWorkspaceBlock(workspace({
      guardrails: [
        {
          id: 'implementation-checks',
          kind: 'verification',
          attach: { from: 'implement', to: 'review' },
          enforcement: 'required',
          allowOverride: false,
          parameters: { checks: ['typecheck', 'test'] },
          correction: { maxRuns: 2, onExhausted: 'waiting-for-human' },
        },
        {
          id: 'visual-rubric',
          kind: 'model-rubric',
          attach: { step: 'review' },
          enforcement: 'required',
          allowOverride: false,
          parameters: { expectationItem: 'prototype.dashboard', evaluatorProfile: 'independent-model-rubric' },
          correction: { maxRuns: 2, onExhausted: 'waiting-for-human' },
        },
        {
          id: 'pixel-review',
          kind: 'pixel-diff',
          attach: { step: 'review' },
          enforcement: 'required',
          allowOverride: false,
          parameters: {
            expectationItem: 'prototype.dashboard',
            capture: {
              browser: 'chromium-1', runtime: 'runtime-1', viewport: '1440x900', dpr: 1,
              fonts: 'fonts-v1', data: 'fixture-v1', animation: 'disabled', region: 'main',
            },
          },
          correction: { maxRuns: 2, onExhausted: 'waiting-for-human' },
        },
      ],
    })) ?? '';

    assert.match(block, /implementation-checks/);
    assert.match(block, /typecheck, test/);
    assert.match(block, /visual-rubric/);
    assert.match(block, /prototype\.dashboard/);
    assert.match(block, /independent-model-rubric/);
    assert.match(block, /pixel-review/);
    assert.doesNotMatch(block, /chromium-1|runtime-1|fonts-v1|fixture-v1/);
  });

  test('names reference files rather than inlining them', () => {
    const block = buildWorkspaceBlock(workspace()) ?? '';

    assert.ok(block.length < 800, `the block should stay small, got ${block.length} characters`);
  });

  test('leaves out what the project did not declare', () => {
    const block =
      buildWorkspaceBlock(
        workspace({
          repository: { root: '.', github: null },
          setup: { command: '', timeoutMs: null },
          verify: [],
          context: { references: [], notes: '' },
        }),
      ) ?? '';

    assert.doesNotMatch(block, /GitHub:/);
    assert.doesNotMatch(block, /Verification commands/);
    assert.doesNotMatch(block, /Worth reading/);
  });

  test('cuts oversized project notes and says where', () => {
    const notes = 'x'.repeat(WORKSPACE_NOTES_MAX_CHARS + 500);
    const block = buildWorkspaceBlock(workspace({ context: { references: [], notes } })) ?? '';

    assert.match(block, /cut here: project notes exceeded/);
    assert.ok(!block.includes(notes), 'the tail past the budget must not be in the prompt');
  });

  test('tells the agent when the declaration itself is broken', () => {
    const block =
      buildWorkspaceBlock({
        status: 'invalid',
        root: '/repo',
        problems: [{ severity: 'error', file: '.awos/workspace.json', path: 'version', message: 'nope' }],
      }) ?? '';

    assert.match(block, /could not be read/);
  });
});

describe('applyWorkspace', () => {
  test('goes ahead of everything else in the prompt', () => {
    assert.equal(applyWorkspace('<workspace>\n\nx\n\n</workspace>', 'Do the thing.'),
      '<workspace>\n\nx\n\n</workspace>\n\nDo the thing.');
  });

  test('leaves the prompt alone when there is no workspace', () => {
    assert.equal(applyWorkspace(null, 'Do the thing.'), 'Do the thing.');
  });
});
