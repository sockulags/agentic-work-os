import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  WORKSPACE_FILE,
  WORKSPACE_LEGACY_INTEGRATION_GUARDRAIL_ID,
  WORKSPACE_LOCAL_FILE,
  WORKSPACE_SCHEMA_VERSION,
  type EffectiveWorkspace,
  type WorkspaceResolution,
} from '@awos/protocol';
import { findWorkspaceRoot, resolveWorkspace } from './resolve.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'awos-workspace-'));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Write one of the two declaration files, creating whatever directories it needs. */
function write(root: string, file: string, contents: unknown): void {
  const path = join(root, file);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
}

function shared(root: string, declaration: Record<string, unknown> = {}): void {
  write(root, WORKSPACE_FILE, {
    version: WORKSPACE_SCHEMA_VERSION,
    name: 'awos',
    ...declaration,
  });
}

/** The resolved workspace, or a failed assertion naming what came back instead. */
function ok(resolution: WorkspaceResolution): EffectiveWorkspace {
  assert.equal(resolution.status, 'ok', `expected a workspace, got ${resolution.status}`);
  return (resolution as { workspace: EffectiveWorkspace }).workspace;
}

describe('resolveWorkspace', () => {
  test('an undeclared directory is not a failure', () => {
    const resolution = resolveWorkspace(tempDir());

    assert.equal(resolution.status, 'none');
  });

  test('resolves defaults for a declaration that only names itself', () => {
    const root = tempDir();
    shared(root);

    const workspace = ok(resolveWorkspace(root));
    assert.equal(workspace.name, 'awos');
    assert.deepEqual(workspace.agents, ['claude', 'codex', 'qwen-local']);
    assert.deepEqual(workspace.repository, { root: '.', github: null });
    assert.equal(workspace.setup.command, '');
    assert.deepEqual(workspace.verify, []);
    assert.equal(workspace.origins.name, 'shared');
    assert.equal(workspace.origins.agents, 'default');
    assert.deepEqual(workspace.sources, [WORKSPACE_FILE]);
  });

  test('resolves a version 1 declaration with empty routing projections', () => {
    const root = tempDir();
    write(root, WORKSPACE_FILE, { version: 1, name: 'legacy' });

    const workspace = ok(resolveWorkspace(root));
    assert.deepEqual(workspace.roles, []);
    assert.deepEqual(workspace.steps, []);
    assert.deepEqual(workspace.routes, []);
    assert.equal(workspace.origins.roles, 'default');
    assert.deepEqual(workspace.sources, [WORKSPACE_FILE]);
  });

  test('resolves shared routing in declaration order with shared provenance', () => {
    const root = tempDir();
    shared(root, {
      agents: ['codex'],
      roles: [{ id: 'maintainer', label: 'Maintainer' }],
      steps: [{ id: 'implement', action: 'Implement', role: 'maintainer', workers: ['codex'] }],
      routes: [
        { id: 'first', match: { anyLabels: ['bug'] }, step: 'implement' },
        { id: 'second', match: { noneLabels: ['blocked'] }, step: 'implement' },
      ],
    });

    const workspace = ok(resolveWorkspace(root));
    assert.deepEqual(workspace.roles, [{ id: 'maintainer', label: 'Maintainer' }]);
    assert.deepEqual(workspace.steps, [{ id: 'implement', action: 'Implement', role: 'maintainer', workers: ['codex'] }]);
    assert.deepEqual(workspace.routes.map((route) => route.id), ['first', 'second']);
    assert.equal(workspace.origins.roles, 'shared');
    assert.equal(workspace.origins.steps, 'shared');
    assert.equal(workspace.origins.routes, 'shared');
  });

  test('resolves a shared v3 catalog with shared guardrail provenance', () => {
    const root = tempDir();
    shared(root, {
      agents: ['codex'],
      verify: [{ name: 'test', command: 'npm test' }],
      roles: [{ id: 'developer', label: 'Developer' }],
      steps: [{ id: 'implement', action: 'Implement', role: 'developer', workers: ['codex'] }],
      guardrails: [{
        id: 'checks',
        kind: 'verification',
        attach: { step: 'implement' },
        enforcement: 'required',
        parameters: { checks: ['test'] },
      }],
    });

    const workspace = ok(resolveWorkspace(root));
    assert.deepEqual(workspace.guardrails, [{
      id: 'checks',
      kind: 'verification',
      attach: { step: 'implement' },
      enforcement: 'required',
      allowOverride: false,
      parameters: { checks: ['test'] },
      correction: { maxRuns: 2, onExhausted: 'waiting-for-human' },
    }]);
    assert.equal(workspace.origins.guardrails, 'shared');
  });

  test('fails closed when a v3 expectation guardrail has no pinned registry', () => {
    const root = tempDir();
    shared(root, {
      agents: ['codex'],
      roles: [{ id: 'developer', label: 'Developer' }],
      steps: [{ id: 'implement', action: 'Implement', role: 'developer', workers: ['codex'] }],
      guardrails: [{
        id: 'evidence', kind: 'evidence-present', attach: { step: 'implement' },
        enforcement: 'required', parameters: { expectationItem: 'scope' },
      }],
    });

    const resolution = resolveWorkspace(root);
    assert.equal(resolution.status, 'invalid');
    assert.equal(resolution.status === 'invalid' ? resolution.problems[0]?.path : null, 'guardrails[0].parameters.expectationItem');
    assert.match(resolution.status === 'invalid' ? resolution.problems[0]?.message ?? '' : '', /No pinned expectation registry/);
  });

  test('fails closed when a v3 model guardrail has no evaluator capability registry', () => {
    const root = tempDir();
    shared(root, {
      agents: ['codex'],
      roles: [{ id: 'reviewer', label: 'Reviewer' }],
      steps: [{ id: 'review', action: 'Review', role: 'reviewer', workers: ['codex'] }],
      guardrails: [{
        id: 'rubric', kind: 'model-rubric', attach: { step: 'review' },
        enforcement: 'required', parameters: { expectationItem: 'scope', evaluatorProfile: 'independent-model' },
      }],
    });

    const resolution = resolveWorkspace(root, { expectationItemIds: ['scope'] });
    assert.equal(resolution.status, 'invalid');
    assert.equal(resolution.status === 'invalid' ? resolution.problems[0]?.path : null, 'guardrails[0].parameters.evaluatorProfile');
    assert.match(resolution.status === 'invalid' ? resolution.problems[0]?.message ?? '' : '', /No evaluator capability registry/);
  });

  test('resolves registry-backed expectation and evaluator references when supplied', () => {
    const root = tempDir();
    shared(root, {
      agents: ['codex'],
      roles: [{ id: 'reviewer', label: 'Reviewer' }],
      steps: [{ id: 'review', action: 'Review', role: 'reviewer', workers: ['codex'] }],
      guardrails: [{
        id: 'rubric', kind: 'model-rubric', attach: { step: 'review' },
        enforcement: 'required', parameters: { expectationItem: 'scope', evaluatorProfile: 'independent-model' },
      }],
    });

    const resolution = resolveWorkspace(root, {
      expectationItemIds: ['scope'],
      evaluatorProfileIds: ['independent-model'],
    });
    assert.equal(resolution.status, 'ok');
  });

  test('rejects an explicit lane-to-workspace guardrail when legacy integration normalizes the same attachment', () => {
    const root = tempDir();
    shared(root, {
      verify: [{ name: 'test', command: 'npm test' }],
      integration: { requires: ['test'] },
      agents: ['codex'],
      roles: [
        { id: 'lane-owner', label: 'Lane owner' },
        { id: 'workspace-owner', label: 'Workspace owner' },
      ],
      steps: [
        { id: 'lane', action: 'Lane', role: 'lane-owner', workers: ['codex'] },
        { id: 'workspace', action: 'Workspace', role: 'workspace-owner', workers: ['codex'] },
      ],
      guardrails: [{
        id: 'explicit-integration', kind: 'verification', attach: { from: 'lane', to: 'workspace' },
        enforcement: 'required', parameters: { checks: ['test'] },
      }],
    });

    const resolution = resolveWorkspace(root);
    assert.equal(resolution.status, 'invalid');
    assert.equal(resolution.status === 'invalid' ? resolution.problems[0]?.path : null, 'guardrails[0].attach');
    assert.match(resolution.status === 'invalid' ? resolution.problems[0]?.message ?? '' : '', /reserved legacy integration guardrail/);
  });

  test('keeps explicit noncolliding guardrails and legacy integration normalization separate', () => {
    const root = tempDir();
    shared(root, {
      verify: [
        { name: 'test', command: 'npm test' },
        { name: 'typecheck', command: 'npm run typecheck' },
      ],
      integration: { requires: ['test'] },
      agents: ['codex'],
      roles: [{ id: 'developer', label: 'Developer' }],
      steps: [{ id: 'implement', action: 'Implement', role: 'developer', workers: ['codex'] }],
      guardrails: [{
        id: 'checks', kind: 'verification', attach: { step: 'implement' },
        enforcement: 'required', parameters: { checks: ['typecheck'] },
      }],
    });

    const workspace = ok(resolveWorkspace(root));
    assert.equal(workspace.guardrails.length, 2);
    assert.deepEqual(workspace.guardrails[0]?.parameters, { checks: ['typecheck'] });
    assert.deepEqual(workspace.guardrails[1], {
      id: WORKSPACE_LEGACY_INTEGRATION_GUARDRAIL_ID,
      kind: 'verification',
      attach: { from: 'lane', to: 'workspace' },
      enforcement: 'required',
      allowOverride: false,
      parameters: { checks: ['test'] },
      correction: { maxRuns: 2, onExhausted: 'waiting-for-human' },
    });
    assert.deepEqual(workspace.integration.requires, ['test']);
  });

  test('projects legacy integration into one reserved verification guardrail', () => {
    const root = tempDir();
    shared(root, {
      version: 2,
      verify: [{ name: 'test', command: 'npm test' }, { name: 'typecheck', command: 'npm run typecheck' }],
      integration: { requires: ['test', 'typecheck'], allowOverride: true },
    });

    const workspace = ok(resolveWorkspace(root));
    assert.equal(workspace.guardrails.length, 1);
    assert.deepEqual(workspace.guardrails[0], {
      id: WORKSPACE_LEGACY_INTEGRATION_GUARDRAIL_ID,
      kind: 'verification',
      attach: { from: 'lane', to: 'workspace' },
      enforcement: 'required',
      allowOverride: true,
      parameters: { checks: ['test', 'typecheck'] },
      correction: { maxRuns: 2, onExhausted: 'waiting-for-human' },
    });
    assert.equal(workspace.origins.guardrails, 'shared');
    assert.deepEqual(workspace.integration.requires, ['test', 'typecheck']);
  });

  test('resolves from a subdirectory, so a thread anywhere in the repo finds it', () => {
    const root = tempDir();
    shared(root);
    const nested = join(root, 'packages', 'core', 'src');
    mkdirSync(nested, { recursive: true });

    assert.equal(findWorkspaceRoot(nested), root);
    assert.equal(ok(resolveWorkspace(nested)).root, root);
  });

  test('the nearest declaration wins, so a checkout inside another answers for itself', () => {
    const outer = tempDir();
    shared(outer, { name: 'outer' });
    const inner = join(outer, 'vendor', 'inner');
    mkdirSync(inner, { recursive: true });
    shared(inner, { name: 'inner' });

    assert.equal(ok(resolveWorkspace(inner)).name, 'inner');
    assert.equal(ok(resolveWorkspace(outer)).name, 'outer');
  });

  describe('precedence', () => {
    test('a local override replaces the shared value and says so', () => {
      const root = tempDir();
      shared(root, { setup: { command: 'npm install' }, agents: ['claude', 'codex'] });
      write(root, WORKSPACE_LOCAL_FILE, {
        version: WORKSPACE_SCHEMA_VERSION,
        setup: { command: 'pnpm install --offline' },
      });

      const workspace = ok(resolveWorkspace(root));
      assert.equal(workspace.setup.command, 'pnpm install --offline');
      assert.equal(workspace.origins.setup, 'local');
      // Untouched fields keep both their value and their provenance.
      assert.deepEqual(workspace.agents, ['claude', 'codex']);
      assert.equal(workspace.origins.agents, 'shared');
      assert.deepEqual(workspace.sources, [WORKSPACE_FILE, WORKSPACE_LOCAL_FILE]);
    });

    test('an override replaces a whole field rather than merging into it', () => {
      const root = tempDir();
      shared(root, { repository: { root: '.', github: 'sockulags/awos' } });
      write(root, WORKSPACE_LOCAL_FILE, {
        version: WORKSPACE_SCHEMA_VERSION,
        repository: { root: 'checkout' },
      });

      assert.deepEqual(ok(resolveWorkspace(root)).repository, { root: 'checkout', github: null });
    });

    test('the environment fills a gap the project left', () => {
      const root = tempDir();
      shared(root);

      const workspace = ok(resolveWorkspace(root, { laneSetup: 'npm ci' }));
      assert.equal(workspace.setup.command, 'npm ci');
      assert.equal(workspace.origins.setup, 'environment');
    });

    test('the environment does not overrule a project that declared setup', () => {
      const root = tempDir();
      shared(root, { setup: { command: 'npm install' } });

      const workspace = ok(resolveWorkspace(root, { laneSetup: 'npm ci' }));
      assert.equal(workspace.setup.command, 'npm install');
      assert.equal(workspace.origins.setup, 'shared');
    });
  });

  describe('invalid configuration', () => {
    test('a broken shared declaration resolves to invalid, with the problems', () => {
      const root = tempDir();
      write(root, WORKSPACE_FILE, { version: 99, name: 'awos' });

      const resolution = resolveWorkspace(root);
      assert.equal(resolution.status, 'invalid');
      assert.equal(resolution.status === 'invalid' && resolution.problems[0]?.path, 'version');
    });

    test('a broken local override is an error too, not a value silently ignored', () => {
      const root = tempDir();
      shared(root);
      write(root, WORKSPACE_LOCAL_FILE, '{ not json');

      const resolution = resolveWorkspace(root);
      assert.equal(resolution.status, 'invalid');
      assert.equal(
        resolution.status === 'invalid' && resolution.problems[0]?.file,
        WORKSPACE_LOCAL_FILE,
      );
    });

    test('a local override cannot replace shared routing', () => {
      const root = tempDir();
      shared(root, {
        roles: [{ id: 'maintainer', label: 'Maintainer' }],
      });
      write(root, WORKSPACE_LOCAL_FILE, {
        version: WORKSPACE_SCHEMA_VERSION,
        roles: [],
      });

      const resolution = resolveWorkspace(root);
      assert.equal(resolution.status, 'invalid');
      assert.equal(
        resolution.status === 'invalid' && resolution.problems[0]?.path,
        'roles',
      );
    });

    test('a local v3 declaration cannot replace or weaken shared guardrails', () => {
      const root = tempDir();
      shared(root, {
        agents: ['codex'],
        verify: [{ name: 'test', command: 'npm test' }],
        roles: [{ id: 'developer', label: 'Developer' }],
        steps: [{ id: 'implement', action: 'Implement', role: 'developer', workers: ['codex'] }],
        guardrails: [{
          id: 'checks', kind: 'verification', attach: { step: 'implement' },
          enforcement: 'absolute', parameters: { checks: ['test'] },
        }],
      });
      write(root, WORKSPACE_LOCAL_FILE, {
        version: 3,
        guardrails: [],
      });

      const resolution = resolveWorkspace(root);
      assert.equal(resolution.status, 'invalid');
      assert.deepEqual(
        resolution.status === 'invalid' ? resolution.problems.map((problem) => problem.path) : [],
        ['guardrails'],
      );
    });

    test('a local declaration cannot change a command selected by a shared v3 verification guardrail', () => {
      const root = tempDir();
      shared(root, {
        verify: [{ name: 'test', command: 'npm test' }],
        agents: ['codex'],
        roles: [{ id: 'developer', label: 'Developer' }],
        steps: [{ id: 'implement', action: 'Implement', role: 'developer', workers: ['codex'] }],
        guardrails: [{
          id: 'checks', kind: 'verification', attach: { step: 'implement' },
          enforcement: 'required', parameters: { checks: ['test'] },
        }],
      });
      write(root, WORKSPACE_LOCAL_FILE, {
        version: WORKSPACE_SCHEMA_VERSION,
        verify: [{ name: 'test', command: 'pnpm test' }],
      });

      const resolution = resolveWorkspace(root);
      assert.equal(resolution.status, 'invalid');
      assert.equal(resolution.status === 'invalid' ? resolution.problems[0]?.path : null, 'verify[0].command');
      assert.match(resolution.status === 'invalid' ? resolution.problems[0]?.message ?? '' : '', /cannot change shared check/);
    });

    test('a local declaration cannot remove a command selected by a shared v3 guardrail', () => {
      const root = tempDir();
      shared(root, {
        verify: [{ name: 'test', command: 'npm test' }],
        agents: ['codex'],
        roles: [{ id: 'developer', label: 'Developer' }],
        steps: [{ id: 'implement', action: 'Implement', role: 'developer', workers: ['codex'] }],
        guardrails: [{
          id: 'checks', kind: 'verification', attach: { step: 'implement' },
          enforcement: 'required', parameters: { checks: ['test'] },
        }],
      });
      write(root, WORKSPACE_LOCAL_FILE, { version: WORKSPACE_SCHEMA_VERSION, verify: [] });

      const resolution = resolveWorkspace(root);
      assert.equal(resolution.status, 'invalid');
      assert.equal(resolution.status === 'invalid' ? resolution.problems[0]?.path : null, 'verify');
      assert.match(resolution.status === 'invalid' ? resolution.problems[0]?.message ?? '' : '', /cannot remove shared check/);
    });

    test('a local declaration cannot change a normalized legacy integration command under v3', () => {
      const root = tempDir();
      shared(root, {
        verify: [{ name: 'test', command: 'npm test' }],
        integration: { requires: ['test'] },
      });
      write(root, WORKSPACE_LOCAL_FILE, {
        version: 2,
        verify: [{ name: 'test', command: 'pnpm test' }],
      });

      const resolution = resolveWorkspace(root);
      assert.equal(resolution.status, 'invalid');
      assert.equal(resolution.status === 'invalid' ? resolution.problems[0]?.path : null, 'verify[0].command');
    });

    test('a local verification change is harmless when no shared v3 guardrail selects it', () => {
      const root = tempDir();
      shared(root, { verify: [{ name: 'unrelated', command: 'npm test' }] });
      write(root, WORKSPACE_LOCAL_FILE, {
        version: WORKSPACE_SCHEMA_VERSION,
        verify: [{ name: 'unrelated', command: 'pnpm test' }],
      });

      const workspace = ok(resolveWorkspace(root));
      assert.deepEqual(workspace.verify, [{ name: 'unrelated', command: 'pnpm test' }]);
      assert.equal(workspace.origins.verify, 'local');
    });

    test('a legacy local integration cannot override a schema-v3 workspace policy', () => {
      const root = tempDir();
      shared(root, { integration: { requires: ['test'] }, verify: [{ name: 'test', command: 'npm test' }] });
      write(root, WORKSPACE_LOCAL_FILE, {
        version: 2,
        integration: { requires: [], allowOverride: true },
      });

      const resolution = resolveWorkspace(root);
      assert.equal(resolution.status, 'invalid');
      assert.equal(resolution.status === 'invalid' ? resolution.problems[0]?.path : null, 'integration');
    });

    test('a local override alone does not make a directory a workspace', () => {
      const root = tempDir();
      write(root, WORKSPACE_LOCAL_FILE, { version: WORKSPACE_SCHEMA_VERSION, name: 'local-only' });

      assert.equal(resolveWorkspace(root).status, 'none');
    });
  });

  describe('unresolved values', () => {
    test('a reference file that is not there is a warning, not a refusal', () => {
      const root = tempDir();
      shared(root, { context: { references: ['ARCHITECTURE.md'] } });

      const resolution = resolveWorkspace(root);
      assert.equal(resolution.status, 'ok');
      const problems = resolution.status === 'ok' ? resolution.problems : [];
      assert.equal(problems.length, 1);
      assert.equal(problems[0]?.severity, 'warning');
      assert.equal(problems[0]?.path, 'context.references[0]');
    });

    test('a reference file that is there produces nothing to say', () => {
      const root = tempDir();
      shared(root, { context: { references: ['ARCHITECTURE.md'] } });
      writeFileSync(join(root, 'ARCHITECTURE.md'), '# Architecture\n', 'utf8');

      const resolution = resolveWorkspace(root);
      assert.deepEqual(resolution.status === 'ok' ? resolution.problems : ['unreachable'], []);
    });

    test('a repository root that is not there is a warning', () => {
      const root = tempDir();
      shared(root, { repository: { root: 'checkout' } });

      const resolution = resolveWorkspace(root);
      assert.equal(resolution.status === 'ok' && resolution.problems[0]?.path, 'repository.root');
    });
  });

  test('picks up an edit made between calls, without a restart', () => {
    const root = tempDir();
    shared(root, { name: 'before' });
    assert.equal(ok(resolveWorkspace(root)).name, 'before');

    shared(root, { name: 'after' });
    assert.equal(ok(resolveWorkspace(root)).name, 'after');
  });
});
