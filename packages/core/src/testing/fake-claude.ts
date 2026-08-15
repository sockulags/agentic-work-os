#!/usr/bin/env node
/**
 * A fake `claude -p --input-format stream-json` for integration tests.
 *
 * It speaks the real wire format — system/init, partial stream_event deltas, an
 * assistant message with a tool_use block, the matching tool_result, and a final result
 * event — so the adapter under test exercises its actual parsing path rather than a
 * mock. Behaviour is scripted through argv so one binary covers several scenarios.
 *
 * Usage: fake-claude.js [--tool] [--permission] [--slow]
 */

import { LineDecoder } from '../util/jsonl.js';

const args = new Set(process.argv.slice(2));
const SESSION_ID = '11111111-2222-3333-4444-555555555555';

let turn = 0;

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
