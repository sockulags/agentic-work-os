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
      assert.match(result.problems[0]?.message ?? '', /understands version 1/);
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
