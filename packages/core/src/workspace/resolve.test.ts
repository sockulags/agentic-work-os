import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  WORKSPACE_FILE,
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
