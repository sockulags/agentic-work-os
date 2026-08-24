import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { WORKSPACE_FILE, WORKSPACE_SCHEMA_VERSION } from '@awos/protocol';
import { parseDeclaration, type ParseOptions } from './declaration.js';

const options: ParseOptions = { file: WORKSPACE_FILE, standalone: true };
const registryOptions: ParseOptions = {
  ...options,
  expectationItemIds: ['evidence.plan', 'question.scope', 'review.semantic', 'prototype.dashboard', 'scope'],
  evaluatorProfileIds: ['independent-model-rubric', 'independent-model'],
};

function parse(value: unknown, parseOptions: ParseOptions = registryOptions) {
  return parseDeclaration(JSON.stringify(value), parseOptions);
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
      assert.match(result.problems[0]?.message ?? '', /understands version 1, 2 and 3/);
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

  describe('schema-v3 guardrails', () => {
    function v3(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        version: 3,
        name: 'awos',
        agents: ['codex'],
        verify: [
          { name: 'typecheck', command: 'npm run typecheck' },
          { name: 'test', command: 'npm test' },
        ],
        roles: [
          { id: 'developer', label: 'Developer' },
          { id: 'reviewer', label: 'Reviewer' },
          { id: 'integrator', label: 'Integrator' },
        ],
        steps: [
          { id: 'implement', action: 'Implement', role: 'developer', workers: ['codex'] },
          { id: 'review', action: 'Review', role: 'reviewer', workers: ['codex'] },
          { id: 'integrate', action: 'Integrate', role: 'integrator', workers: ['codex'] },
        ],
        ...overrides,
      };
    }

    test('accepts every built-in kind and applies bounded defaults', () => {
      const result = parse(v3({
        guardrails: [
          {
            id: 'checks', kind: 'verification', attach: { from: 'implement', to: 'review' },
            enforcement: 'required', parameters: { checks: ['typecheck', 'test'] },
          },
          {
            id: 'evidence', kind: 'evidence-present', attach: { step: 'implement' },
            enforcement: 'advisory', parameters: { expectationItem: 'evidence.plan' },
          },
          {
            id: 'answer', kind: 'mandatory-answer', attach: { step: 'review' },
            enforcement: 'absolute', parameters: { expectationItem: 'question.scope' },
          },
          {
            id: 'attestation', kind: 'human-attestation', attach: { from: 'review', to: 'integrate' },
            enforcement: 'required', parameters: { expectationItem: 'review.semantic', authority: 'user' },
          },
          {
            id: 'pixels', kind: 'pixel-diff', attach: { step: 'integrate' },
            enforcement: 'absolute', parameters: {
              expectationItem: 'prototype.dashboard',
              capture: {
                browser: 'chromium', runtime: 'node', viewport: '1440x900', dpr: 1,
                fonts: 'fonts-v1', data: 'fixture-v1', animation: 'disabled', region: 'main',
              },
              exact: true,
            },
          },
          {
            id: 'rubric', kind: 'model-rubric', attach: { from: 'implement', to: 'integrate' },
            enforcement: 'required', parameters: {
              expectationItem: 'prototype.dashboard', evaluatorProfile: 'independent-model-rubric',
            },
          },
        ],
      }));

      assert.deepEqual(result.problems, []);
      assert.equal(result.declaration?.guardrails?.length, 6);
      assert.deepEqual(result.declaration?.guardrails?.[0]?.correction, {
        maxRuns: 2,
        onExhausted: 'waiting-for-human',
      });
    });

    test('parses an explicit lane-to-workspace guardrail with legacy integration for resolver collision handling', () => {
      const result = parse(v3({
        roles: [
          { id: 'lane-owner', label: 'Lane owner' },
          { id: 'workspace-owner', label: 'Workspace owner' },
        ],
        steps: [
          { id: 'lane', action: 'Lane', role: 'lane-owner', workers: ['codex'] },
          { id: 'workspace', action: 'Workspace', role: 'workspace-owner', workers: ['codex'] },
        ],
        verify: [{ name: 'test', command: 'npm test' }],
        integration: { requires: ['test'] },
        guardrails: [{
          id: 'explicit-integration', kind: 'verification', attach: { from: 'lane', to: 'workspace' },
          enforcement: 'required', parameters: { checks: ['test'] },
        }],
      }));

      assert.deepEqual(result.problems, []);
      assert.deepEqual(result.declaration?.guardrails?.[0]?.attach, { from: 'lane', to: 'workspace' });
      assert.deepEqual(result.declaration?.integration?.requires, ['test']);
    });

    test('keeps v1 and v2 readable with no declared guardrail catalog', () => {
      for (const version of [1, 2]) {
        const result = parse({ version, name: `v${version}` });
        assert.deepEqual(result.problems, []);
        assert.equal(result.declaration?.guardrails, undefined);
      }
    });

    test('rejects guardrails in an older schema instead of ignoring them', () => {
      const result = parse({ version: 2, name: 'awos', guardrails: [] });

      assert.deepEqual(paths(result), ['guardrails']);
      assert.match(result.problems[0]?.message ?? '', /only supported by schema version 3/);
    });

    test('collects closed-shape and reference problems at their declaration paths', () => {
      const result = parse(v3({
        guardrails: [{
          id: 'bad', kind: 'not-a-kind', extra: true,
          attach: { from: 'missing', to: 'missing', extra: true },
          enforcement: 'required', parameters: { expectationItem: 'unknown-item', prompt: 'mutable' },
          correction: { maxRuns: 6, onExhausted: 'retry' },
        }],
      }));

      assert.deepEqual(paths(result), [
        'guardrails[0].extra',
        'guardrails[0].kind',
        'guardrails[0].attach.extra',
        'guardrails[0].attach.from',
        'guardrails[0].attach.to',
        'guardrails[0].attach.to',
        'guardrails[0].correction.maxRuns',
        'guardrails[0].correction.onExhausted',
      ]);
    });

    test('rejects duplicate ids, duplicate attachments, self-transitions, and illegal overrides', () => {
      const result = parse(v3({
        guardrails: [
          {
            id: 'same', kind: 'evidence-present', attach: { step: 'implement' },
            enforcement: 'advisory', allowOverride: true, parameters: { expectationItem: 'scope' },
          },
          {
            id: 'same', kind: 'model-rubric', attach: { step: 'implement' },
            enforcement: 'absolute', parameters: { expectationItem: 'scope', evaluatorProfile: 'independent-model' },
          },
        ],
      }));

      assert.deepEqual(paths(result), [
        'guardrails[0].allowOverride',
        'guardrails[1].id',
        'guardrails[1].attach',
        'guardrails[1].enforcement',
      ]);
    });

    test('requires exactly one singular step or transition attachment', () => {
      const arrayResult = parse(v3({
        guardrails: [{
          id: 'array', kind: 'verification', attach: [{ step: 'implement' }],
          enforcement: 'required', parameters: { checks: ['test'] },
        }],
      }));
      assert.deepEqual(paths(arrayResult), ['guardrails[0].attach']);
      assert.match(arrayResult.problems[0]?.message ?? '', /exactly one step or transition/);

      const bothResult = parse(v3({
        guardrails: [{
          id: 'both', kind: 'verification', attach: { step: 'implement', from: 'implement', to: 'review' },
          enforcement: 'required', parameters: { checks: ['test'] },
        }],
      }));
      assert.deepEqual(paths(bothResult), ['guardrails[0].attach']);
    });

    test('fails closed when expectation or evaluator registries are unavailable', () => {
      const expectationResult = parse(v3({
        guardrails: [{
          id: 'evidence', kind: 'evidence-present', attach: { step: 'implement' },
          enforcement: 'required', parameters: { expectationItem: 'scope' },
        }],
      }), options);
      assert.deepEqual(paths(expectationResult), ['guardrails[0].parameters.expectationItem']);
      assert.match(expectationResult.problems[0]?.message ?? '', /No pinned expectation registry/);

      const evaluatorResult = parse(v3({
        guardrails: [{
          id: 'rubric', kind: 'model-rubric', attach: { step: 'review' }, enforcement: 'required',
          parameters: { expectationItem: 'scope', evaluatorProfile: 'independent-model-rubric' },
        }],
      }), { ...options, expectationItemIds: ['scope'] });
      assert.deepEqual(paths(evaluatorResult), ['guardrails[0].parameters.evaluatorProfile']);
      assert.match(evaluatorResult.problems[0]?.message ?? '', /No evaluator capability registry/);
    });

    test('validates pinned expectation and evaluator registries when supplied', () => {
      const value = v3({
        guardrails: [{
          id: 'rubric', kind: 'model-rubric', attach: { step: 'review' }, enforcement: 'required',
          parameters: { expectationItem: 'missing', evaluatorProfile: 'not-registered' },
        }],
      });
      const result = parseDeclaration(JSON.stringify(value), {
        ...options,
        expectationItemIds: ['known'],
        evaluatorProfileIds: ['independent-model'],
      });

      assert.deepEqual(paths(result), ['guardrails[0].parameters.expectationItem']);
      assert.match(result.problems[0]?.message ?? '', /Unknown expectation item/);

      const profileResult = parseDeclaration(JSON.stringify(v3({
        guardrails: [{
          id: 'rubric', kind: 'model-rubric', attach: { step: 'review' }, enforcement: 'required',
          parameters: { expectationItem: 'known', evaluatorProfile: 'not-registered' },
        }],
      })), {
        ...options,
        expectationItemIds: ['known'],
        evaluatorProfileIds: ['independent-model'],
      });
      assert.deepEqual(paths(profileResult), ['guardrails[0].parameters.evaluatorProfile']);
      assert.match(profileResult.problems[0]?.message ?? '', /Unknown evaluator profile/);
    });

    test('rejects model self-evaluation and absolute pixel capture without every input', () => {
      const result = parseDeclaration(JSON.stringify(v3({
        guardrails: [
          {
            id: 'self', kind: 'model-rubric', attach: { step: 'implement' }, enforcement: 'required',
            parameters: { expectationItem: 'scope', evaluatorProfile: 'codex' },
          },
          {
            id: 'pixels', kind: 'pixel-diff', attach: { step: 'review' }, enforcement: 'absolute',
            parameters: {
              expectationItem: 'prototype.dashboard',
              capture: {
                browser: 'chromium', runtime: 'node', viewport: '1440x900', dpr: 1,
                fonts: 'fonts-v1', data: 'fixture-v1', animation: 'disabled',
              },
            },
          },
        ],
      })), { ...registryOptions, evaluatorProfileIds: ['codex', 'independent-model'] });

      assert.ok(result.problems.some((problem) => problem.path === 'guardrails[0].parameters.evaluatorProfile'));
      assert.match(result.problems.find((problem) => problem.path === 'guardrails[0].parameters.evaluatorProfile')?.message ?? '', /independent evaluator capability/);
      assert.ok(result.problems.some((problem) => problem.path === 'guardrails[1].parameters.capture.region'));
    });

    test('requires explicit exact pixels before allowing absolute pixel enforcement', () => {
      const result = parse(v3({
        guardrails: [{
          id: 'pixels', kind: 'pixel-diff', attach: { step: 'review' }, enforcement: 'absolute',
          parameters: {
            expectationItem: 'prototype.dashboard',
            capture: {
              browser: 'chromium/128', runtime: 'node/22', viewport: '1440x900', dpr: 1,
              fonts: 'fonts-v1', data: 'fixture-v1', animation: 'disabled-v1', region: 'main',
            },
          },
        }],
      }));
      assert.deepEqual(paths(result), ['guardrails[0].parameters.exact']);
      assert.match(result.problems[0]?.message ?? '', /explicitly require exact pixels/);
    });

    test('refuses local guardrails and schema-v3 legacy policy overrides', () => {
      const guardrails = parseDeclaration(JSON.stringify({ version: 3, guardrails: [] }), { file: 'local', standalone: false });
      const integration = parseDeclaration(JSON.stringify({ version: 3, integration: { allowOverride: true } }), { file: 'local', standalone: false });

      assert.deepEqual(paths(guardrails), ['guardrails']);
      assert.deepEqual(paths(integration), ['integration']);
    });

    test('refuses executable policy and nested composition fields', () => {
      const result = parse(v3({
        includes: ['other.json'],
        guardrails: [{
          id: 'checks', kind: 'verification', attach: { step: 'implement' }, enforcement: 'required',
          parameters: { checks: ['test'] }, scripts: ['npm test'], dependsOn: ['other'], expression: true,
        }],
      }));

      assert.deepEqual(paths(result), [
        'includes',
        'guardrails[0].scripts',
        'guardrails[0].dependsOn',
        'guardrails[0].expression',
      ]);
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
