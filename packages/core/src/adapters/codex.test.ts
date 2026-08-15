import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AdapterEvent } from '@awos/protocol';
import {
  CodexAdapter,
  itemType,
  classifyCodexItem,
  summarizeCodexItem,
  codexItemOutput,
  extractCodexPlan,
  describeCodexApproval,
} from './codex.js';
import type { AdapterContext } from './agent.js';
import type { HarnessConfig } from '../config.js';

describe('itemType', () => {
  test('accepts either field name Codex has used', () => {
    assert.equal(itemType({ id: '1', type: 'CommandExecution' }), 'commandexecution');
    assert.equal(itemType({ id: '1', itemType: 'FileChange' }), 'filechange');
  });

  test('returns unknown rather than throwing on a bare item', () => {
    assert.equal(itemType({ id: '1' }), 'unknown');
  });
});

describe('classifyCodexItem', () => {
  test('classifies by substring so version drift does not break it', () => {
    assert.equal(classifyCodexItem('commandexecution'), 'command');
    assert.equal(classifyCodexItem('localshellcall'), 'command');
    assert.equal(classifyCodexItem('filechange'), 'file_edit');
    assert.equal(classifyCodexItem('applypatch'), 'file_edit');
    assert.equal(classifyCodexItem('mcptoolcall'), 'mcp');
    assert.equal(classifyCodexItem('websearch'), 'web');
    assert.equal(classifyCodexItem('somethingelse'), 'other');
  });
});

describe('summarizeCodexItem', () => {
  test('joins an argv-array command', () => {
    assert.equal(
      summarizeCodexItem({ id: '1', command: ['cargo', 'test', '--all'] }),
      'cargo test --all',
    );
  });

  test('passes a string command through', () => {
    assert.equal(summarizeCodexItem({ id: '1', command: 'ls -la' }), 'ls -la');
  });

  test('names a single changed file', () => {
    assert.equal(
      summarizeCodexItem({ id: '1', changes: [{ path: 'src/a.rs' }] }),
      'edit src/a.rs',
    );
  });

  test('counts and truncates many changed files', () => {
    const changes = ['a', 'b', 'c', 'd'].map((p) => ({ path: p }));
    assert.equal(summarizeCodexItem({ id: '1', changes }), 'edit 4 files: a, b, c…');
  });

  test('qualifies an MCP tool with its server', () => {
    assert.equal(
      summarizeCodexItem({ id: '1', name: 'create_issue', server: 'github' }),
      'github/create_issue',
    );
  });
});

describe('codexItemOutput', () => {
  test('prefers aggregated output', () => {
    assert.equal(
      codexItemOutput({ id: '1', aggregatedOutput: 'all of it', output: 'partial' }),
      'all of it',
    );
  });

  test('renders file changes as a readable patch', () => {
    const text = codexItemOutput({
      id: '1',
      changes: [{ path: 'a.ts', diff: '@@ -1 +1 @@\n-old\n+new' }],
    });
    assert.equal(text, '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new');
    assert.match(text, /^--- a\/a\.ts\n\+\+\+ b\/a\.ts\n@@ /);
  });

  test('renders additions with a /dev/null source header', () => {
    assert.equal(
      codexItemOutput({
        id: '1',
        changes: [{ path: 'new.ts', kind: 'ADDED', diff: '@@ -0,0 +1 @@\n+new' }],
      }),
      '--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new',
    );
  });

  test('renders deletions with a /dev/null destination header', () => {
    assert.equal(
      codexItemOutput({
        id: '1',
        changes: [{ path: 'old.ts', kind: 'DELETED', diff: '@@ -1 +0,0 @@\n-old' }],
      }),
      '--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old',
    );
  });

  test('preserves changed-without-diff output', () => {
    assert.equal(codexItemOutput({ id: '1', changes: [{ path: 'a.ts' }] }), 'changed a.ts');
  });

  test('serializes a structured result', () => {
    assert.match(codexItemOutput({ id: '1', result: { ok: true } }), /"ok": true/);
  });

  test('returns empty string when there is nothing to show', () => {
    assert.equal(codexItemOutput({ id: '1' }), '');
  });
});

describe('CodexAdapter diff updates', () => {
  test('emits an empty snapshot so it supersedes a previous diff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awos-codex-adapter-'));
    const server = join(dir, 'server.mjs');
    writeFileSync(
      server,
      String.raw`const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    if (message.method === 'thread/start') {
      emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
      emit({ method: 'thread/started', params: { thread: { id: 'thread-1' } } });
    }
    if (message.method === 'turn/start') {
      emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
      emit({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
      emit({ method: 'turn/diff/updated', params: { diff: 'diff --git a/a.ts b/a.ts' } });
      emit({ method: 'turn/diff/updated', params: { diff: '' } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));`,
      'utf8',
    );

    const events: AdapterEvent[] = [];
    const config: HarnessConfig = {
      dataDir: dir,
      claudeBin: process.execPath,
      codexBin: process.execPath,
      claudeBinArgs: [],
      codexBinArgs: [server],
      claudeModel: '',
      codexModel: '',
      host: '127.0.0.1',
      port: 0,
      replayMaxChars: 1_000,
      replayMaxToolOutput: 1_000,
      interruptGraceMs: 1_000,
      approvalTimeoutMs: 1_000,
      codexInitTimeoutMs: 2_000,
    };
    const adapter = new CodexAdapter({
      threadId: 'thread-1',
      cwd: dir,
      config,
      permissionMode: 'default',
      permissionBridge: {} as AdapterContext['permissionBridge'],
      resumeSessionId: null,
      emit: (event) => events.push(event),
      onSessionId: () => {},
    });

    try {
      await adapter.sendTurn('revert it');
      const diffs = events.filter(
        (event): event is Extract<AdapterEvent, { kind: 'diff.updated' }> =>
          event.kind === 'diff.updated',
      );
      assert.deepEqual(
        diffs.map((event) => event.patch),
        ['diff --git a/a.ts b/a.ts', ''],
      );
    } finally {
      await adapter.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('extractCodexPlan', () => {
  test('reads the plan key', () => {
    assert.deepEqual(
      extractCodexPlan({ plan: [{ step: 'one', status: 'completed' }] }),
      [{ text: 'one', status: 'completed' }],
    );
  });

  test('falls back to the steps key', () => {
    assert.deepEqual(extractCodexPlan({ steps: [{ text: 'two', status: 'active' }] }), [
      { text: 'two', status: 'in_progress' },
    ]);
  });

  test('accepts bare strings', () => {
    assert.deepEqual(extractCodexPlan({ plan: ['just text'] }), [
      { text: 'just text', status: 'pending' },
    ]);
  });

  test('normalizes done to completed', () => {
    assert.deepEqual(extractCodexPlan({ plan: [{ step: 'x', status: 'done' }] }), [
      { text: 'x', status: 'completed' },
    ]);
  });

  test('returns empty on garbage', () => {
    assert.deepEqual(extractCodexPlan({}), []);
    assert.deepEqual(extractCodexPlan({ plan: 'nope' }), []);
  });
});

describe('describeCodexApproval', () => {
  test('shows the command and cwd for an exec approval', () => {
    const { title, detail, toolKind } = describeCodexApproval({
      command: ['rm', '-rf', 'dist'],
      cwd: '/repo',
    });
    assert.equal(title, 'Run a shell command');
    assert.equal(toolKind, 'command');
    assert.match(detail, /rm -rf dist/);
    assert.match(detail, /\/repo/);
  });

  test('renders the diff for a patch approval', () => {
    const { title, toolKind, detail } = describeCodexApproval({
      changes: [{ path: 'x.rs', diff: '-old\n+new' }],
    });
    assert.equal(title, 'Apply file changes');
    assert.equal(toolKind, 'file_edit');
    assert.match(detail, /\+new/);
  });

  test('falls back to the reason for an unrecognized shape', () => {
    const { title } = describeCodexApproval({ reason: 'Needs network access' });
    assert.equal(title, 'Needs network access');
  });
});
