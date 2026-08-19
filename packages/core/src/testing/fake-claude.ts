#!/usr/bin/env node
/**
 * A fake `claude -p --input-format stream-json` for integration tests.
 *
 * It speaks the real wire format — system/init, partial stream_event deltas, an
 * assistant message with a tool_use block, the matching tool_result, and a final result
 * event — so the adapter under test exercises its actual parsing path rather than a
 * mock. Behaviour is scripted through argv so one binary covers several scenarios.
 *
 * Usage: fake-claude.js [--tool] [--tools] [--permission] [--slow]
 */

import { LineDecoder } from '../util/jsonl.js';

const args = new Set(process.argv.slice(2));
const SESSION_ID = '11111111-2222-3333-4444-555555555555';

let turn = 0;

/**
 * A realistic burst of parallel tool calls for `--tools`.
 *
 * One call per turn is enough to prove the adapter parses a `tool_use`, but it says
 * nothing about what a turn actually looks like on screen. The UI questions — does a run
 * of calls collapse, does a failure stay visible, does a patch still render as a diff —
 * only have answers once a single turn carries several kinds at once, one of them broken.
 */
const TOOL_RUN: Array<{
  name: string;
  input: Record<string, unknown>;
  result: string;
  isError?: boolean;
}> = [
  {
    name: 'Read',
    input: { file_path: 'apps/ui/src/lib/transcript.ts' },
    result: Array.from({ length: 40 }, (_, i) => `${i + 1}→const line = ${i};`).join('\n'),
  },
  {
    name: 'Grep',
    input: { pattern: 'useHarness', output_mode: 'files_with_matches' },
    result: ['apps/ui/src/App.tsx', 'apps/ui/src/hooks/useHarness.ts'].join('\n'),
  },
  {
    name: 'Bash',
    input: { command: 'npm test --workspace @awos/ui' },
    result: 'Test Files  4 passed (4)\n     Tests  61 passed (61)',
  },
  {
    name: 'Bash',
    input: { command: 'npm run lint' },
    result: "sh: line 1: eslint: command not found\nnpm ERR! Lifecycle script `lint` failed",
    isError: true,
  },
  {
    name: 'Edit',
    input: { file_path: 'apps/ui/src/components/ToolBlock.tsx' },
    result: [
      '--- a/apps/ui/src/components/ToolBlock.tsx',
      '+++ b/apps/ui/src/components/ToolBlock.tsx',
      '@@ -1,4 +1,4 @@',
      " import { useState } from 'react';",
      '-const OUTPUT_PREVIEW_LINES = 12;',
      '+const OUTPUT_PREVIEW_LINES = 20;',
      ' ',
    ].join('\n'),
  },
];

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTurn(text: string): Promise<void> {
  turn += 1;
  const messageId = `msg_${turn}`;

  if (turn === 1) {
    emit({
      type: 'system',
      subtype: 'init',
      session_id: SESSION_ID,
      model: 'claude-fake-1',
      tools: ['Bash', 'Read'],
      cwd: process.cwd(),
    });
  }

  // Streaming text, delivered as real partial-message events.
  emit({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: messageId } },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });
  emit({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });

  for (const chunk of ['Working', ' on: ', text.slice(0, 20)]) {
    emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    });
    if (args.has('--slow')) await sleep(5);
  }

  emit({
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 0 },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });

  const finalText = `Working on: ${text.slice(0, 20)}`;
  emit({
    type: 'assistant',
    message: {
      id: messageId,
      role: 'assistant',
      model: 'claude-fake-1',
      content: [{ type: 'text', text: finalText }],
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });

  if (args.has('--tool')) {
    const toolUseId = `toolu_${turn}`;
    emit({
      type: 'assistant',
      message: {
        id: `${messageId}_tool`,
        role: 'assistant',
        content: [
          { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'echo hello' } },
        ],
      },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    });

    if (args.has('--permission')) {
      // The real CLI would call the permission MCP tool here; the adapter's approval
      // path is covered separately through the bridge.
      await sleep(10);
    }

    emit({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'hello\n' }],
      },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    });
  }

  if (args.has('--tools')) await runToolBurst(messageId);

  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: finalText,
    duration_ms: 42,
    num_turns: turn,
    total_cost_usd: 0.001,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
    session_id: SESSION_ID,
  });
}

/** Several calls in one turn, then a closing sentence they were supposed to inform. */
async function runToolBurst(messageId: string): Promise<void> {
  const ids = TOOL_RUN.map((_, i) => `toolu_${turn}_${i}`);

  emit({
    type: 'assistant',
    message: {
      id: `${messageId}_tools`,
      role: 'assistant',
      content: TOOL_RUN.map((call, i) => ({
        type: 'tool_use',
        id: ids[i],
        name: call.name,
        input: call.input,
      })),
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });

  if (args.has('--slow')) await sleep(20);

  emit({
    type: 'user',
    message: {
      role: 'user',
      content: TOOL_RUN.map((call, i) => ({
        type: 'tool_result',
        tool_use_id: ids[i],
        content: call.result,
        is_error: call.isError === true,
      })),
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });

  emit({
    type: 'assistant',
    message: {
      id: `${messageId}_after`,
      role: 'assistant',
      content: [{ type: 'text', text: 'Tests pass; lint is not installed in this checkout.' }],
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });
}

function main(): void {
  const decoder = new LineDecoder();
  const queue: string[] = [];
  let running = false;

  const drain = async (): Promise<void> => {
    if (running) return;
    running = true;
    while (queue.length > 0) {
      const next = queue.shift();
      if (next !== undefined) await runTurn(next);
    }
    running = false;
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    for (const line of decoder.push(chunk)) {
      let msg: { type?: string; message?: { content?: Array<{ text?: string }> } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue;
      }
      if (msg.type !== 'user') continue;
      const text = msg.message?.content?.[0]?.text ?? '';
      queue.push(text);
      void drain();
    }
  });

  // Closing stdin is how the harness asks for a clean exit.
  process.stdin.on('end', () => process.exit(0));
}

main();
