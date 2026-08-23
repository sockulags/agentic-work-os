import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { WORKSPACE_FILE, WORKSPACE_SCHEMA_VERSION } from '@awos/protocol';
import { parseDeclaration } from './declaration.js';

const options = { file: WORKSPACE_FILE, standalone: true };

function parse(value: unknown) {
  return parseDeclaration(JSON.stringify(value), options);
}

/** Every problem's path, so a test can say what was flagged without matching prose. */
function paths(result: ReturnType<typeof parse>): string[] {
  return result.problems.map((problem) => problem.path);
}

describe('parseDeclaration', () => {
  test('accepts the smallest declaration that means anything', () => {
    const result = parse({ version: WORKSPACE_SCHEMA_VERSION, name: 'awos' });

    assert.deepEqual(result.problems, []);
    assert.equal(result.declaration?.name, 'awos');
    // Everything else stays undefined rather than defaulted: the resolver owns defaults,
    // so the parser can say what the file actually claimed.
    assert.equal(result.declaration?.agents, undefined);
  });

  test('accepts a full declaration', () => {
    const result = parse({
      version: WORKSPACE_SCHEMA_VERSION,
      name: 'agentic-work-os',
      repository: { root: '.', github: 'sockulags/agentic-work-os' },
      agents: ['claude', 'codex'],
      setup: { command: 'npm install', timeoutMs: 600_000 },
      verify: [
        { name: 'typecheck', command: 'npm run typecheck' },
        { name: 'test', command: 'npm test' },
      ],
      context: { references: ['ARCHITECTURE.md'], notes: 'Read the architecture first.' },
    });

    assert.deepEqual(result.problems, []);
    assert.equal(result.declaration?.repository?.github, 'sockulags/agentic-work-os');
    assert.equal(result.declaration?.setup?.timeoutMs, 600_000);
    assert.deepEqual(result.declaration?.verify?.map((entry) => entry.name), ['typecheck', 'test']);
  });

  test('keeps version 1 declarations compatible and projects no routing', () => {
    const result = parse({ version: 1, name: 'legacy' });

    assert.deepEqual(result.problems, []);
    assert.equal(result.declaration?.version, 1);
    assert.equal(result.declaration?.roles, undefined);
    assert.equal(result.declaration?.steps, undefined);
    assert.equal(result.declaration?.routes, undefined);
  });

  test('accepts the closed version 2 routing contract', () => {
    const result = parse({
      version: 2,
      name: 'awos',
      agents: ['codex'],
      roles: [{ id: 'maintainer', label: 'Maintainer' }],
      steps: [{ id: 'implement', action: 'Implement the issue', role: 'maintainer', workers: ['codex'] }],
      routes: [{
        id: 'implement-issues',
        match: { allLabels: ['implement'], noneLabels: ['blocked'] },
        step: 'implement',
      }],
    });

    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.declaration?.roles, [{ id: 'maintainer', label: 'Maintainer' }]);
    assert.deepEqual(result.declaration?.steps, [{
      id: 'implement', action: 'Implement the issue', role: 'maintainer', workers: ['codex'],
    }]);
    assert.deepEqual(result.declaration?.routes, [{
      id: 'implement-issues',
      match: { allLabels: ['implement'], noneLabels: ['blocked'] },
      step: 'implement',
    }]);
  });

  test('rejects unknown routing fields at every nested level', () => {
    const result = parse({
      version: 2,
      name: 'awos',
      roles: [{ id: 'maintainer', label: 'Maintainer', color: 'blue' }],
      steps: [{ id: 'implement', action: 'Implement', role: 'maintainer', workers: ['codex'], guard: true }],
      routes: [{ id: 'issues', match: { allLabels: ['implement'], labels: ['other'] }, step: 'implement', priority: 1 }],
    });

    assert.deepEqual(paths(result), ['roles[0].color', 'steps[0].guard', 'routes[0].priority', 'routes[0].match.labels']);
  });

  test('uses the existing lowercase hyphenated rule for routing ids and text', () => {
    const result = parse({
      version: 2,
      name: 'awos',
      roles: [{ id: 'Not_Stable', label: '   ' }],
    });

    assert.deepEqual(paths(result), ['roles[0].id', 'roles[0].label']);
  });

  test('reports invalid routing value types at their declaration paths', () => {
    const result = parse({ version: 2, name: 'awos', roles: 'maintainer', steps: {}, routes: null });

    assert.deepEqual(paths(result), ['roles', 'steps', 'routes']);
    assert.match(result.problems[0]?.message ?? '', /array of role objects/);
  });

  test('rejects duplicate ids and unknown routing references', () => {
    const result = parse({
      version: 2,
      name: 'awos',
      roles: [{ id: 'maintainer', label: 'Maintainer' }, { id: 'maintainer', label: 'Another' }],
      steps: [
        { id: 'implement', action: 'Implement', role: 'maintainer', workers: ['codex'] },
        { id: 'implement', action: 'Implement again', role: 'maintainer', workers: ['codex'] },
      ],
      routes: [
        { id: 'issues', match: { anyLabels: ['implement'] }, step: 'missing-step' },
        { id: 'issues', match: { anyLabels: ['other'] }, step: 'implement' },
      ],
    });

    assert.deepEqual(paths(result), [
      'roles[1].id',
      'steps[1].id',
      'routes[0].step',
      'routes[1].id',
    ]);
  });

  test('requires known workers that are allowed by the agents list', () => {
    const result = parse({
      version: 2,
      name: 'awos',
      agents: ['claude'],
      roles: [{ id: 'maintainer', label: 'Maintainer' }],
      steps: [{ id: 'implement', action: 'Implement', role: 'maintainer', workers: ['codex', 'not-a-profile'] }],
    });

    assert.deepEqual(paths(result), ['steps[0].workers[0]', 'steps[0].workers[1]']);
    assert.match(result.problems[0]?.message ?? '', /not allowed/);
    assert.match(result.problems[1]?.message ?? '', /Known profiles/);
  });

  test('rejects a duplicate worker id at its exact step path', () => {
    const result = parse({
      version: 2,
      name: 'awos',
      roles: [{ id: 'maintainer', label: 'Maintainer' }],
      steps: [{ id: 'implement', action: 'Implement', role: 'maintainer', workers: ['codex', 'codex'] }],
    });

    assert.deepEqual(paths(result), ['steps[0].workers[1]']);
    assert.match(result.problems[0]?.message ?? '', /listed more than once/);
  });

  test('rejects an unknown role reference at its exact step path', () => {
    const result = parse({
      version: 2,
      name: 'awos',
      roles: [{ id: 'maintainer', label: 'Maintainer' }],
      steps: [{ id: 'review', action: 'Review', role: 'reviewer', workers: ['codex'] }],
    });

    assert.deepEqual(paths(result), ['steps[0].role']);
    assert.match(result.problems[0]?.message ?? '', /Unknown role "reviewer"/);
  });

  test('rejects empty, duplicate, and contradictory route matchers', () => {
    const result = parse({
      version: 2,
      name: 'awos',
      roles: [{ id: 'maintainer', label: 'Maintainer' }],
      steps: [{ id: 'implement', action: 'Implement', role: 'maintainer', workers: ['codex'] }],
      routes: [
        { id: 'empty', match: {}, step: 'implement' },
        { id: 'duplicate', match: { allLabels: ['bug', 'bug'] }, step: 'implement' },
        { id: 'contradiction', match: { allLabels: ['bug'], noneLabels: ['bug'] }, step: 'implement' },
      ],
    });

    assert.deepEqual(paths(result), [
      'routes[0].match',
      'routes[1].match.allLabels[1]',
      'routes[2].match.noneLabels',
    ]);
  });

  test('allows satisfiable overlap between matcher lists', () => {
    const result = parse({
      version: 2,
      name: 'awos',
      roles: [{ id: 'maintainer', label: 'Maintainer' }],
      steps: [{ id: 'implement', action: 'Implement', role: 'maintainer', workers: ['codex'] }],
      routes: [{
        id: 'issues',
        match: { allLabels: ['bug'], anyLabels: ['bug', 'ready'], noneLabels: ['ready'] },
        step: 'implement',
      }],
    });

    assert.deepEqual(result.problems, []);
  });

  test('rejects an any-label requirement when every option is forbidden', () => {
    const result = parse({
      version: 2,
      name: 'awos',
      roles: [{ id: 'maintainer', label: 'Maintainer' }],
      steps: [{ id: 'implement', action: 'Implement', role: 'maintainer', workers: ['codex'] }],
      routes: [{
        id: 'impossible',
        match: { anyLabels: ['bug', 'blocked'], noneLabels: ['bug', 'blocked'] },
        step: 'implement',
      }],
    });

    assert.deepEqual(paths(result), ['routes[0].match.anyLabels']);
    assert.match(result.problems[0]?.message ?? '', /cannot match/);
  });

  test('does not allow a local override to define shared routing', () => {
    const result = parseDeclaration(JSON.stringify({
      version: 2,
      roles: [],
      steps: [],
      routes: [],
    }), { file: 'local', standalone: false });

    assert.deepEqual(paths(result), ['roles', 'steps', 'routes']);
    assert.match(result.problems[0]?.message ?? '', /shared workspace declaration/);
  });

  test('reports every problem at once, so one edit can fix the file', () => {
    const result = parse({
      version: WORKSPACE_SCHEMA_VERSION,
      name: '',
      agents: ['claude', 'gemini'],
      verify: [{ name: 'Typecheck', command: 'tsc' }],
    });

    assert.equal(result.declaration, null);
    assert.deepEqual(paths(result), ['name', 'agents[1]', 'verify[0].name']);
  });

  describe('version', () => {
    test('is required', () => {
      assert.deepEqual(paths(parse({ name: 'awos' })), ['version']);
    });

    test('refuses a schema this build does not know', () => {
      const result = parse({ version: WORKSPACE_SCHEMA_VERSION + 1, name: 'awos' });

      assert.equal(result.declaration, null);
      assert.match(result.problems[0]?.message ?? '', /understands version 1 and 2/);
    });
  });

  test('refuses unknown settings, because the schema is the guard against secrets', () => {
    const result = parse({ version: WORKSPACE_SCHEMA_VERSION, name: 'awos', apiToken: 'sk-live-123' });

    assert.equal(result.declaration, null);
    assert.deepEqual(paths(result), ['apiToken']);
  });

  test('refuses unknown settings inside a nested object too', () => {
    const result = parse({
      version: WORKSPACE_SCHEMA_VERSION,
      name: 'awos',
      setup: { command: 'npm ci', shell: 'pwsh' },
    });

    assert.deepEqual(paths(result), ['setup.shell']);
  });

  test('names a duplicate verification command rather than silently keeping one', () => {
    const result = parse({
      version: WORKSPACE_SCHEMA_VERSION,
      name: 'awos',
      verify: [
        { name: 'test', command: 'npm test' },
        { name: 'test', command: 'npm run test:e2e' },
      ],
    });

    assert.deepEqual(paths(result), ['verify[1].name']);
  });

  describe('paths', () => {
    test('refuse absolute paths, which are the machine-specific thing this file must not hold', () => {
      const result = parse({
        version: WORKSPACE_SCHEMA_VERSION,
        name: 'awos',
        context: { references: ['C:/Users/lucas/notes.md'] },
      });

      assert.deepEqual(paths(result), ['context.references[0]']);
      assert.match(result.problems[0]?.message ?? '', /relative to the workspace root/);
    });

    test('refuse escaping the workspace root', () => {
      const result = parse({
        version: WORKSPACE_SCHEMA_VERSION,
        name: 'awos',
        repository: { root: '../elsewhere' },
      });

      assert.deepEqual(paths(result), ['repository.root']);
    });

    test('refuse backslashes, because the same file is read on every platform', () => {
      const result = parse({
        version: WORKSPACE_SCHEMA_VERSION,
        name: 'awos',
        context: { references: ['docs\\guide.md'] },
      });

      assert.match(result.problems[0]?.message ?? '', /forward slashes/);
    });
  });

  test('rejects a github reference that is not owner/name', () => {
    const result = parse({
      version: WORKSPACE_SCHEMA_VERSION,
      name: 'awos',
      repository: { github: 'https://github.com/sockulags/agentic-work-os' },
    });

    assert.deepEqual(paths(result), ['repository.github']);
  });

  describe('integration requirements', () => {
    test('accepts requirements that name declared verification commands', () => {
      const result = parse({
        version: WORKSPACE_SCHEMA_VERSION,
        name: 'awos',
        verify: [
          { name: 'test', command: 'npm test' },
          { name: 'typecheck', command: 'tsc -b' },
        ],
        integration: { requires: ['typecheck', 'test'], allowOverride: false },
      });

      assert.deepEqual(result.problems, []);
      assert.deepEqual(result.declaration?.integration?.requires, ['typecheck', 'test']);
    });

    test('rejects a requirement no verification command answers to', () => {
      const result = parse({
        version: WORKSPACE_SCHEMA_VERSION,
        name: 'awos',
        verify: [{ name: 'test', command: 'npm test' }],
        integration: { requires: ['e2e'] },
      });

      // A requirement that can never be satisfied should fail when the file is written,
      // not when somebody is trying to hand over work.
      assert.deepEqual(paths(result), ['integration.requires[0]']);
      assert.match(result.problems[0]?.message ?? '', /Declare it under "verify"/);
    });

    test('rejects the same requirement twice', () => {
      const result = parse({
        version: WORKSPACE_SCHEMA_VERSION,
        name: 'awos',
        verify: [{ name: 'test', command: 'npm test' }],
        integration: { requires: ['test', 'test'] },
      });

      assert.deepEqual(paths(result), ['integration.requires[1]']);
    });

    test('an override permission is a boolean, not a string that reads like one', () => {
      const result = parse({
        version: WORKSPACE_SCHEMA_VERSION,
        name: 'awos',
        integration: { allowOverride: 'yes' },
      });

      assert.deepEqual(paths(result), ['integration.allowOverride']);
    });
  });

  test('says what is wrong with unparseable JSON instead of throwing', () => {
    const result = parseDeclaration('{ "version": 1, ', options);

    assert.equal(result.declaration, null);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0]?.message ?? '', /Not valid JSON/);
  });

  test('rejects a file that is valid JSON but not an object', () => {
    const result = parseDeclaration('[]', options);

    assert.equal(result.declaration, null);
    assert.match(result.problems[0]?.message ?? '', /JSON object/);
  });

  test('a local override need not restate the project identity', () => {
    const raw = JSON.stringify({ version: WORKSPACE_SCHEMA_VERSION, setup: { command: 'pnpm i' } });

    assert.deepEqual(parseDeclaration(raw, { file: 'local', standalone: false }).problems, []);
    assert.deepEqual(paths(parseDeclaration(raw, { file: 'shared', standalone: true })), ['name']);
  });
});
