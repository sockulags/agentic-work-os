import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent, ModelTarget } from '@awos/protocol';
import type { Query } from '@qwen-code/sdk';
import type { HarnessConfig } from '../config.js';
import type { BridgeDecision, BridgeHandler, BridgeRequest } from '../permission-bridge.js';
import type { AdapterContext } from './agent.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { QwenCodeAdapter, resetQwenInferenceSlotForTests } from './qwen-code.js';

/**
 * One turn, one id — stated once for every adapter.
 *
 * `turnId` is what folds a stream of events into a turn: turn rendering, replay, and diff
 * and usage attribution all group by it. An adapter that changes the id part-way leaves
 * its opening event in a turn that never reappears and everything after it in a turn that
 * never started, and no consumer can tell the two apart from a genuine pair of turns. The
 * Codex adapter did exactly that with the turn id the app-server addresses turns by, which
 * is why the rule is asserted against a full turn per worker rather than inside one of
 * them: a normalized field that means something different per agent is worse than none.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, '..', 'testing', 'fake-claude.js');
const FAKE_CODEX = join(here, '..', 'testing', 'fake-codex.js');

/** The id Codex gives the first turn of a thread; it must never be the harness's. */
const CODEX_NATIVE_TURN_ID = 'turn_1';

function testConfig(dir: string, overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    dataDir: dir,
    claudeBin: process.execPath,
    codexBin: process.execPath,
    claudeBinArgs: [],
    codexBinArgs: [],
    claudeModel: '',
    codexModel: '',
    host: '127.0.0.1',
    port: 0,
    replayMaxChars: 1_000,
    replayMaxToolOutput: 1_000,
    interruptGraceMs: 1_000,
    approvalTimeoutMs: 5_000,
    codexInitTimeoutMs: 10_000,
    laneSetup: '',
    laneSetupTimeoutMs: 60_000,
    ghBin: process.execPath,
    ghBinArgs: [],
    ghTimeoutMs: 5_000,
    qwenBaseUrl: 'http://127.0.0.1:1234/v1',
    qwenModel: 'qwen3.8-27b-local',
    qwenApiKey: 'local-placeholder',
    qwenBin: '',
    qwenTurnTimeoutMs: 5_000,
    ...overrides,
  };
}

/**
 * The turn's own span, and the single id every event in it carries.
 *
 * `required` names the kinds the turn has to have produced, so the assertion cannot pass
 * on a turn that emitted nothing between its two ends. The span stops at `turn.completed`
 * because the idle status that follows it belongs to the worker, not to the turn.
 */
function assertOneTurnId(events: AdapterEvent[], required: Array<AdapterEvent['kind']>): string {
  const startedAt = events.findIndex((event) => event.kind === 'turn.started');
  const completedAt = events.findIndex((event) => event.kind === 'turn.completed');
  assert.ok(startedAt >= 0, 'the turn never started');
  assert.ok(completedAt > startedAt, 'the turn never completed');

  const turnId = events[startedAt]?.turnId;
  assert.equal(typeof turnId, 'string', 'turn.started carried no turn id');

  const span = events.slice(startedAt, completedAt + 1);
  assert.deepEqual(
    span
      .filter((event) => event.turnId !== turnId)
      .map((event) => `${event.kind}=${String(event.turnId)}`),
    [],
    'every event of the turn must carry the id turn.started opened it with',
  );

  for (const kind of required) {
    assert.ok(
      span.some((event) => event.kind === kind),
      `the turn emitted no ${kind}`,
    );
  }

  return turnId as string;
}

describe('turn identity', () => {
  test('Codex carries one id from turn.started through turn.completed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awos-turn-id-codex-'));
    const events: AdapterEvent[] = [];
    let adapter: CodexAdapter;
    adapter = new CodexAdapter({
      threadId: 'thread-1',
      cwd: dir,
      config: testConfig(dir, {
        codexBinArgs: [FAKE_CODEX, '--tool', '--approval', '--diff'],
      }),
      permissionMode: 'default',
      permissionBridge: {} as AdapterContext['permissionBridge'],
      resumeSessionId: null,
      emit: (event) => {
        events.push(event);
        if (event.kind === 'approval.requested') adapter.resolveApproval(event.approvalId, 'allow');
      },
      onSessionId: () => {},
    });

    try {
      await adapter.sendTurn('run the command');

      const turnId = assertOneTurnId(events, [
        'agent.status',
        'approval.requested',
        'approval.resolved',
        'tool.started',
        'tool.output',
        'tool.completed',
        'plan.updated',
        'diff.updated',
        'message.delta',
        'message.completed',
        'usage',
      ]);

      // The wire id is the app-server's handle on the turn — used to interrupt it and to
      // tell its notifications from an abandoned turn's — and never the normalized id.
      assert.notEqual(turnId, CODEX_NATIVE_TURN_ID);
    } finally {
      await adapter.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Claude carries one id from turn.started through turn.completed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awos-turn-id-claude-'));
    const events: AdapterEvent[] = [];
    let adapter: ClaudeAdapter;
    // Claude's approvals arrive over the permission bridge rather than on its own stream,
    // so the request is raised from here the moment the tool it belongs to opens.
    const permission: {
      ask: BridgeHandler | null;
      answered: Promise<BridgeDecision> | null;
    } = { ask: null, answered: null };

    adapter = new ClaudeAdapter({
      threadId: 'thread-1',
      cwd: dir,
      config: testConfig(dir, { claudeBinArgs: [FAKE_CLAUDE, '--tool', '--think'] }),
      permissionMode: 'default',
      permissionBridge: {
        port: 0,
        token: 'test-token',
        registerThread: (_threadId: string, handler: BridgeHandler) => {
          permission.ask = handler;
        },
        unregisterThread: () => {},
      } as unknown as AdapterContext['permissionBridge'],
      resumeSessionId: null,
      emit: (event) => {
        events.push(event);
        if (event.kind === 'approval.requested') adapter.resolveApproval(event.approvalId, 'allow');
        if (event.kind === 'tool.started' && permission.answered === null) {
          const request: BridgeRequest = {
            threadId: 'thread-1',
            toolName: event.name,
            input: { command: 'echo hello' },
            toolUseId: event.itemId,
          };
          permission.answered = permission.ask?.(request) ?? null;
        }
      },
      onSessionId: () => {},
    });

    try {
      await adapter.sendTurn('run the command');
      assert.equal((await permission.answered)?.behavior, 'allow');

      assertOneTurnId(events, [
        'agent.status',
        'approval.requested',
        'approval.resolved',
        'tool.started',
        'tool.completed',
        'reasoning.delta',
        'reasoning.completed',
        'message.delta',
        'message.completed',
        'usage',
      ]);
    } finally {
      await adapter.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Qwen carries one id from turn.started through turn.completed', async () => {
    resetQwenInferenceSlotForTests();
    const dir = mkdtempSync(join(tmpdir(), 'awos-turn-id-qwen-'));
    const events: AdapterEvent[] = [];
    const target: ModelTarget = {
      id: 'qwen38-local',
      provider: 'openai-compatible',
      model: 'qwen3.8-27b-local',
      endpoint: 'http://127.0.0.1:1234/v1',
      authProfile: 'local-placeholder',
    };
    let adapter: QwenCodeAdapter;
    adapter = new QwenCodeAdapter(
      {
        threadId: 'thread-1',
        cwd: dir,
        config: testConfig(dir),
        permissionMode: 'default',
        permissionBridge: {} as AdapterContext['permissionBridge'],
        resumeSessionId: null,
        emit: (event) => {
          events.push(event);
          if (event.kind === 'approval.requested') {
            adapter.resolveApproval(event.approvalId, 'allow');
          }
        },
        onSessionId: () => {},
      },
      target,
      {
        query: (args) =>
          ({
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'system',
                subtype: 'init',
                uuid: 'system',
                session_id: 'qwen-session-1',
                model: 'qwen3.8-27b-local',
              };
              yield {
                type: 'stream_event',
                uuid: 'partial',
                session_id: 'qwen-session-1',
                parent_tool_use_id: null,
                event: {
                  type: 'content_block_start',
                  index: 0,
                  content_block: { type: 'text', text: '' },
                },
              };
              yield {
                type: 'stream_event',
                uuid: 'partial',
                session_id: 'qwen-session-1',
                parent_tool_use_id: null,
                event: {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: 'editing the readme' },
                },
              };
              const canUseTool = args.options.canUseTool;
              if (!canUseTool) throw new Error('canUseTool missing');
              await canUseTool(
                'edit',
                { file_path: 'README.md' },
                { signal: new AbortController().signal },
              );
              yield {
                type: 'assistant',
                uuid: 'final',
                session_id: 'qwen-session-1',
                parent_tool_use_id: null,
                message: {
                  id: 'message',
                  type: 'message',
                  role: 'assistant',
                  model: 'qwen3.8-27b-local',
                  content: [
                    { type: 'text', text: 'editing the readme' },
                    {
                      type: 'tool_use',
                      id: 'tool-1',
                      name: 'edit',
                      input: { file_path: 'README.md' },
                    },
                  ],
                  usage: { input_tokens: 1, output_tokens: 2 },
                },
              };
              yield {
                type: 'user',
                uuid: 'tool-result',
                session_id: 'qwen-session-1',
                parent_tool_use_id: null,
                message: {
                  role: 'user',
                  content: [
                    { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false },
                  ],
                },
              };
              yield {
                type: 'result',
                subtype: 'success',
                uuid: 'result',
                session_id: 'qwen-session-1',
                is_error: false,
                duration_ms: 1,
                duration_api_ms: 1,
                num_turns: 1,
                result: 'done',
                usage: { input_tokens: 3, output_tokens: 4 },
                permission_denials: [],
              };
            },
            getSessionId: () => 'qwen-session-1',
            interrupt: async () => {},
            close: async () => {},
          }) as unknown as Query,
      },
    );

    try {
      await adapter.sendTurn('edit the readme');

      assertOneTurnId(events, [
        'agent.status',
        'approval.requested',
        'approval.resolved',
        'tool.started',
        'tool.completed',
        'message.delta',
        'message.completed',
        'usage',
      ]);
    } finally {
      await adapter.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
