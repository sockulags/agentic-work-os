import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AdapterEvent, ModelTarget, PermissionMode } from '@awos/protocol';
import type { Query } from '@qwen-code/sdk';
import { HUMAN_AUTH_TOKEN_ENV } from '../config.js';
import type { HarnessConfig } from '../config.js';
import type { AdapterContext } from './agent.js';
import {
  QWEN_CORE_TOOLS,
  QwenCodeAdapter,
  isQwenResumeNotFoundError,
  isAllowedQwenShellCommand,
  qwenPermissionPolicy,
  resetQwenInferenceSlotForTests,
} from './qwen-code.js';

function config(): HarnessConfig {
  return {
    dataDir: '/tmp/awos-test',
    claudeBin: 'claude', codexBin: 'codex', claudeBinArgs: [], codexBinArgs: [],
    claudeModel: '', codexModel: '', host: '127.0.0.1', port: 0,
    replayMaxChars: 1000, replayMaxToolOutput: 1000, laneSetup: '', laneSetupTimeoutMs: 1000,
    interruptGraceMs: 1000, approvalTimeoutMs: 1000, codexInitTimeoutMs: 1000,
    ghBin: 'gh', ghBinArgs: [], ghTimeoutMs: 1000,
    qwenBaseUrl: 'http://127.0.0.1:1234/v1', qwenModel: 'qwen3.8-27b-local',
    qwenApiKey: 'local-placeholder', qwenBin: '', qwenTurnTimeoutMs: 1000,
  };
}

const target: ModelTarget = {
  id: 'qwen38-local', provider: 'openai-compatible', model: 'qwen3.8-27b-local',
  endpoint: 'http://127.0.0.1:1234/v1', authProfile: 'local-placeholder',
};

function context(events: AdapterEvent[], permissionMode: PermissionMode = 'default', resumeSessionId: string | null = null): AdapterContext {
  return {
    threadId: 't1', cwd: process.cwd(), config: config(), permissionMode,
    permissionBridge: {} as AdapterContext['permissionBridge'], resumeSessionId,
    emit: (event) => events.push(event), onSessionId: () => {},
  };
}

function fakeQuery(messages: unknown[], delayMs = 0): Query {
  const iterator = {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      yield* messages;
    },
    getSessionId: () => 'qwen-session-1',
    interrupt: async () => {},
    close: async () => {},
  };
  return iterator as unknown as Query;
}

describe('Qwen Code policy', () => {
  test('allows only exact verify commands and read-only git commands', () => {
    assert.equal(isAllowedQwenShellCommand('npm test', ['npm test']), true);
    assert.equal(isAllowedQwenShellCommand('git status --short', []), true);
    assert.equal(isAllowedQwenShellCommand('npm test && whoami', ['npm test']), false);
    assert.equal(isAllowedQwenShellCommand('git push', []), false);
    for (const command of [
      'git diff --output=patch.txt', 'git diff -o patch.txt', 'git diff --ext-diff',
      'git show --textconv', 'git -c core.pager=cat log', 'git --config-env=x=y status',
      'git --paginate log', 'PAGER=cat git log', 'git status --unknown-option',
    ]) assert.equal(isAllowedQwenShellCommand(command, []), false, command);
    for (const command of [
      'git status --short', 'git diff --cached -- README.md', 'git show --stat HEAD',
      'git log --oneline -n5', 'git log -n 5', 'git rev-parse --show-toplevel', 'git ls-files --modified',
    ]) assert.equal(isAllowedQwenShellCommand(command, []), true, command);
    assert.equal(qwenPermissionPolicy('run_shell_command', { command: 'npm test' }, 'default', ['npm test']), 'ask');
    assert.equal(qwenPermissionPolicy('run_shell_command', { command: 'npm test' }, 'bypassPermissions', ['npm test']), 'allow');
    assert.equal(qwenPermissionPolicy('run_shell_command', { command: 'rm -rf .' }, 'bypassPermissions', []), 'deny');
  });

  test('maps edit modes without changing the AWOS PermissionMode values', () => {
    assert.equal(qwenPermissionPolicy('edit', {}, 'default', []), 'ask');
    assert.equal(qwenPermissionPolicy('edit', {}, 'acceptEdits', []), 'allow');
    assert.equal(qwenPermissionPolicy('edit', {}, 'bypassPermissions', []), 'allow');
    assert.deepEqual(QWEN_CORE_TOOLS, ['read_file', 'glob', 'grep_search', 'edit', 'run_shell_command']);
  });
});

describe('QwenCodeAdapter', () => {
  test('passes ordinary bearer context but strips every human-token casing from SDK tools', async () => {
    resetQwenInferenceSlotForTests();
    const humanEnvKeys = [HUMAN_AUTH_TOKEN_ENV, HUMAN_AUTH_TOKEN_ENV.toLowerCase(), 'AwOs_HuMaN_AuTh_ToKeN'];
    const savedOrdinary = process.env['AWOS_TOKEN'];
    const savedHuman = new Map(humanEnvKeys.map((key) => [key, process.env[key]]));
    const options: { env?: Record<string, string> } = {};
    process.env['AWOS_TOKEN'] = 'ordinary-qwen-tool-token';
    humanEnvKeys.forEach((key, index) => { process.env[key] = `human-qwen-tool-token-${index}`; });
    try {
      const adapter = new QwenCodeAdapter(context([]), target, {
        query: (args) => {
          options.env = args.options.env as Record<string, string> | undefined;
          return fakeQuery([]);
        },
      });
      await adapter.sendTurn('inspect environment');
      assert.equal(options.env?.AWOS_TOKEN, 'ordinary-qwen-tool-token');
      assert.equal(Object.keys(options.env ?? {}).some((key) => key.toLowerCase() === HUMAN_AUTH_TOKEN_ENV.toLowerCase()), false);
    } finally {
      if (savedOrdinary === undefined) delete process.env['AWOS_TOKEN'];
      else process.env['AWOS_TOKEN'] = savedOrdinary;
      for (const key of humanEnvKeys) {
        delete process.env[key];
        const value = savedHuman.get(key);
        if (value !== undefined) process.env[key] = value;
      }
    }
  });

  test('accepts an approval resolved synchronously from approval.requested emission', async () => {
    resetQwenInferenceSlotForTests();
    const events: AdapterEvent[] = [];
    const ctx = context(events);
    let adapter: QwenCodeAdapter;
    let decision: unknown = null;
    ctx.emit = (event) => {
      events.push(event);
      if (event.kind === 'approval.requested') adapter.resolveApproval(event.approvalId, 'allow');
    };
    adapter = new QwenCodeAdapter(ctx, target, {
      query: (args) => ({
        async *[Symbol.asyncIterator]() {
          const canUseTool = args.options.canUseTool;
          if (!canUseTool) throw new Error('canUseTool missing');
          decision = await canUseTool('edit', { file_path: 'README.md' }, { signal: new AbortController().signal });
        },
        getSessionId: () => 'qwen-session-1', interrupt: async () => {}, close: async () => {},
      } as unknown as Query),
    });

    await adapter.sendTurn('edit');
    assert.deepEqual(decision, { behavior: 'allow', updatedInput: { file_path: 'README.md' } });
    assert.equal(events.some((event) => event.kind === 'approval.resolved' && event.behavior === 'allow'), true);
  });

  test('denies an approval when its signal aborts during approval.requested emission', async () => {
    resetQwenInferenceSlotForTests();
    const events: AdapterEvent[] = [];
    const ctx = context(events);
    const approvalController = new AbortController();
    let decision: unknown = null;
    ctx.emit = (event) => {
      events.push(event);
      if (event.kind === 'approval.requested') approvalController.abort();
    };
    const adapter = new QwenCodeAdapter(ctx, target, {
      query: (args) => ({
        async *[Symbol.asyncIterator]() {
          const canUseTool = args.options.canUseTool;
          if (!canUseTool) throw new Error('canUseTool missing');
          decision = await canUseTool('edit', { file_path: 'README.md' }, { signal: approvalController.signal });
        },
        getSessionId: () => 'qwen-session-1', interrupt: async () => {}, close: async () => {},
      } as unknown as Query),
    });

    await adapter.sendTurn('edit');
    assert.equal((decision as { behavior?: string } | null)?.behavior, 'deny');
    assert.equal(events.some((event) => event.kind === 'approval.resolved' && event.auto), true);
  });

  test('maps partial text, reasoning, tools, session, usage, and completion events', async () => {
    resetQwenInferenceSlotForTests();
    const events: AdapterEvent[] = [];
    const adapter = new QwenCodeAdapter(context(events), target, {
      query: () => fakeQuery([
        { type: 'system', subtype: 'init', uuid: 's', session_id: 'qwen-session-1', model: 'qwen3.8-27b-local' },
        { type: 'stream_event', uuid: 'partial-uuid', session_id: 'qwen-session-1', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, parent_tool_use_id: null },
        { type: 'stream_event', uuid: 'partial-uuid', session_id: 'qwen-session-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }, parent_tool_use_id: null },
        { type: 'stream_event', uuid: 'partial-uuid', session_id: 'qwen-session-1', event: { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } }, parent_tool_use_id: null },
        { type: 'stream_event', uuid: 'partial-uuid', session_id: 'qwen-session-1', event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'reason' } }, parent_tool_use_id: null },
        { type: 'stream_event', uuid: 'partial-uuid', session_id: 'qwen-session-1', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } } }, parent_tool_use_id: null },
        { type: 'assistant', uuid: 'final-uuid', session_id: 'qwen-session-1', parent_tool_use_id: null, message: { id: 'different-message-id', type: 'message', role: 'assistant', model: 'qwen3.8-27b-local', content: [{ type: 'text', text: 'hello' }, { type: 'thinking', thinking: 'reason' }, { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } }], usage: { input_tokens: 1, output_tokens: 2 } } },
        { type: 'result', subtype: 'success', uuid: 'r', session_id: 'qwen-session-1', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: 'done', usage: { input_tokens: 3, output_tokens: 4 }, permission_denials: [] },
      ]),
    });

    await adapter.sendTurn('inspect');
    assert.equal(events.some((event) => event.kind === 'message.delta' && event.text === 'hello'), true);
    assert.equal(events.some((event) => event.kind === 'reasoning.delta' && event.text === 'reason'), true);
    const textDelta = events.find((event) => event.kind === 'message.delta');
    const textFinal = events.find((event) => event.kind === 'message.completed');
    const reasoningDelta = events.find((event) => event.kind === 'reasoning.delta');
    const reasoningFinal = events.find((event) => event.kind === 'reasoning.completed');
    assert.equal(textDelta?.itemId, textFinal?.itemId);
    assert.equal(reasoningDelta?.itemId, reasoningFinal?.itemId);
    assert.equal(events.filter((event) => event.kind === 'tool.started' && event.itemId === 'tool-1').length, 2);
    assert.equal(events.some((event) => event.kind === 'usage'), true);
    assert.equal(events.some((event) => event.kind === 'turn.completed' && event.reason === 'completed'), true);
  });

  test('records a stream that ends without a result as an error, not a completion', async () => {
    resetQwenInferenceSlotForTests();
    const events: AdapterEvent[] = [];
    const adapter = new QwenCodeAdapter(context(events), target, {
      query: () => fakeQuery([
        { type: 'system', subtype: 'init', uuid: 's', session_id: 'qwen-session-1', model: 'qwen3.8-27b-local' },
        { type: 'assistant', uuid: 'final-uuid', session_id: 'qwen-session-1', parent_tool_use_id: null, message: { id: 'message', type: 'message', role: 'assistant', model: 'qwen3.8-27b-local', content: [{ type: 'text', text: 'half an answer' }], usage: { input_tokens: 1, output_tokens: 1 } } },
      ]),
    });

    await adapter.sendTurn('inspect');

    const terminal = events.filter((event) => event.kind === 'turn.completed');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.kind === 'turn.completed' ? terminal[0].reason : null, 'error');
    const detail = terminal[0]?.kind === 'turn.completed' ? terminal[0].error : null;
    assert.match(detail ?? '', /stream ended without a result/);
    assert.match(detail ?? '', /2 messages arrived, the last of kind assistant/);
    const failure = events.find((event) => event.kind === 'error');
    assert.equal(failure?.kind === 'error' ? failure.severity : null, 'turn');
    assert.equal(failure?.kind === 'error' ? failure.message : null, detail);
  });

  test('reports an empty stream as an error that records no message arrived', async () => {
    resetQwenInferenceSlotForTests();
    const events: AdapterEvent[] = [];
    const adapter = new QwenCodeAdapter(context(events), target, { query: () => fakeQuery([]) });

    await adapter.sendTurn('inspect');

    const terminal = events.find((event) => event.kind === 'turn.completed');
    assert.equal(terminal?.kind === 'turn.completed' ? terminal.reason : null, 'error');
    assert.match(terminal?.kind === 'turn.completed' ? terminal.error ?? '' : '', /no messages arrived/);
  });

  test('rejects a concurrent inference without queuing and releases the slot', async () => {
    resetQwenInferenceSlotForTests();
    const first = new QwenCodeAdapter(context([]), target, { query: () => fakeQuery([], 30) });
    const second = new QwenCodeAdapter(context([]), target, { query: () => fakeQuery([]) });
    const running = first.sendTurn('first');
    await assert.rejects(() => second.sendTurn('second'), /not queued/);
    await running;
    await second.sendTurn('second');
  });

  test('resumes a persisted Qwen session after adapter recreation', async () => {
    resetQwenInferenceSlotForTests();
    const options: Array<Record<string, unknown>> = [];
    const adapter = new QwenCodeAdapter(context([], 'default', 'persisted-session'), target, {
      query: (args) => {
        options.push(args.options as Record<string, unknown>);
        return fakeQuery([
          { type: 'system', subtype: 'init', uuid: 's', session_id: 'qwen-session-1', model: 'qwen3.8-27b-local' },
          { type: 'result', subtype: 'success', uuid: 'r', session_id: 'qwen-session-1', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: 'done', usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [] },
        ]);
      },
    });
    await adapter.sendTurn('continued');
    assert.equal(options.length, 1);
    assert.equal(options[0]?.resume, 'persisted-session');
  });

  test('reports an explicit missing resume before execution as a typed failure', async () => {
    resetQwenInferenceSlotForTests();
    const events: AdapterEvent[] = [];
    const adapter = new QwenCodeAdapter(context(events, 'default', 'stale-session'), target, {
      query: (args) => {
        args.options.stderr?.('No saved session found with ID stale-session.');
        return fakeQuery([]);
      },
    });

    await assert.rejects(() => adapter.sendTurn('recover'), (error: unknown) => {
      assert.equal(isQwenResumeNotFoundError(error), true);
      return isQwenResumeNotFoundError(error);
    });
    assert.equal(events.filter((event) => event.kind === 'error').length, 0);
    assert.equal(events.filter((event) => event.kind === 'turn.completed').length, 0);
  });

  test('updates a streamed tool start with the final shell input and title', async () => {
    resetQwenInferenceSlotForTests();
    const events: AdapterEvent[] = [];
    const adapter = new QwenCodeAdapter(context(events), target, {
      query: () => fakeQuery([
        { type: 'stream_event', uuid: 'partial', session_id: 'qwen-session-1', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-shell', name: 'run_shell_command', input: {} } }, parent_tool_use_id: null },
        { type: 'stream_event', uuid: 'partial', session_id: 'qwen-session-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"npm test"}' } }, parent_tool_use_id: null },
        { type: 'assistant', uuid: 'final', session_id: 'qwen-session-1', parent_tool_use_id: null, message: { id: 'message', type: 'message', role: 'assistant', model: 'qwen3.8-27b-local', content: [{ type: 'tool_use', id: 'tool-shell', name: 'run_shell_command', input: { command: 'npm test' } }], usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: 'result', subtype: 'success', uuid: 'result', session_id: 'qwen-session-1', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: 'done', usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [] },
      ]),
    });

    await adapter.sendTurn('run the test');

    const started = events.filter((event) => event.kind === 'tool.started' && event.itemId === 'tool-shell');
    assert.equal(started.length, 2);
    const final = started.at(-1);
    assert.deepEqual(final?.kind === 'tool.started' ? final.input : null, { command: 'npm test' });
    assert.equal(final?.kind === 'tool.started' ? final.title : null, 'npm test');
  });

  test('schedules AbortController fallback without awaiting a stuck SDK interrupt', async () => {
    resetQwenInferenceSlotForTests();
    const ctx = context([]);
    ctx.config.interruptGraceMs = 10;
    let aborted = false;
    const adapter = new QwenCodeAdapter(ctx, target, {
      query: (args) => ({
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            args.options.abortController?.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
          });
        },
        getSessionId: () => 'qwen-session-1',
        interrupt: () => new Promise<void>(() => {}),
        close: async () => {},
      } as unknown as Query),
    });
    const running = adapter.sendTurn('wait');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await adapter.interrupt();
    assert.equal(aborted, false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(aborted, true);
    await running;
  });

  test('releases the global slot when event emission throws before query construction', async () => {
    resetQwenInferenceSlotForTests();
    const broken = context([]);
    broken.emit = () => { throw new Error('emit failed'); };
    let constructed = false;
    const first = new QwenCodeAdapter(broken, target, { query: () => { constructed = true; return fakeQuery([]); } });
    await assert.rejects(() => first.sendTurn('first'), /emit failed/);
    assert.equal(constructed, false);
    const second = new QwenCodeAdapter(context([]), target, { query: () => fakeQuery([]) });
    await second.sendTurn('second');
  });
});
