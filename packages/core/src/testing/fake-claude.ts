#!/usr/bin/env node
/**
 * A fake `claude -p --input-format stream-json` for integration tests.
 *
 * It speaks the real wire format — system/init, partial stream_event deltas, an
 * assistant message with a tool_use block, the matching tool_result, and a final result
 * event — so the adapter under test exercises its actual parsing path rather than a
 * mock. Behaviour is scripted through argv so one binary covers several scenarios.
 *
 * Usage: fake-claude.js [--tool] [--tools] [--permission] [--slow] [--markdown] [--think]
 *   [--think-omit-final] [--late-result] [--drop-result] [--stall-second] [--silent-first]
 */

import { LineDecoder } from '../util/jsonl.js';
import { writeFileSync } from 'node:fs';

const args = new Set(process.argv.slice(2));

if (args.has('--version')) {
  process.stdout.write('fake-claude 1.0\n');
  process.exit(0);
}

/**
 * How much of the prompt the fake echoes back.
 *
 * The echo is how a test sees what actually landed on the wire. Twenty characters was
 * enough when a prompt was the user's message; standing context blocks — workspace, work
 * item, pinned notes — now sit in front of it, and a window that narrow can only ever show
 * the first of them.
 */
const ECHO_CHARS = 600;

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

let turn = 0;

/**
 * Three ways a turn can be accepted, stream, and then never end in time. The CLI stays
 * alive in all of them; what differs is when — or whether — the closing `result` shows up.
 *
 * `--late-result` holds the first turn's result until the next turn's input arrives — a
 * CLI that was merely slow, so the straggler lands mid-way through a turn it does not
 * belong to.
 * `--drop-result` never sends the first turn's result at all — a CLI whose result event
 * was renamed or dropped, where nothing but the replayed input ever shows the turn ended.
 * `--stall-second` drops the first turn's result and then sits on the second input until
 * a third arrives, so two turns in a row outlive their deadline. The second one only then
 * runs, replaying its input and closing with its own result while a third turn is in
 * flight — the straggler that must not be taken for that third turn's.
 * `--silent-first` replays the first input and then says nothing whatsoever about it — no
 * init, no text, no result. A CLI that took the turn up and hung before producing a word,
 * which is the shape a hang most often has. The second turn runs normally, and the only
 * thing marking the boundary between them is its replayed input.
 */
const lateResult = args.has('--late-result');
const dropResult = args.has('--drop-result');
const stallSecond = args.has('--stall-second');
const silentFirst = args.has('--silent-first');
let sentInit = false;
let withheldResult: unknown = null;

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

/**
 * A reply carrying every markdown construct the transcript renders, cut into deltas.
 *
 * The chunk boundaries are chosen, not computed: two of them fall in the middle of a
 * fence marker, so a renderer that waits for a fence to close is visibly wrong here
 * rather than only under a real agent. The list is the source of truth for the final
 * text too, which keeps deltas and the completed message identical by construction.
 */
function markdownChunks(prompt: string): string[] {
  return [
    '## Plan for ',
    prompt.slice(0, ECHO_CHARS),
    '\n\nThree steps, in order:\n\n',
    '1. **Read** the current renderer\n',
    '   - `Transcript.tsx` owns the message branch\n',
    '   - a nested item, to prove indentation survives\n',
    '2. Swap in the markdown renderer\n',
    '3. Verify against the [docs](https://example.com)\n\n',
    '| Step | Owner | Lines |\n',
    '| --- | --- | ---: |\n',
    '| Parse | remark | 12 |\n',
    '| Highlight | hljs | ',
    '34 |\n\n',
    '``',
    '`ts src/example.ts\n',
    'export function greet(name: string): string {\n',
    '  // 42 is not a name\n',
    '  return "hello " + name;\n',
    '}\n',
    '``',
    '`\n\n',
    '> Done — with ~~strikethrough~~ and `inline code` to finish.\n',
  ];
}

async function runTurn(text: string): Promise<void> {
  turn += 1;
  const messageId = `msg_${turn}`;

  // The stalled turn reports in at last, ahead of the turn that is about to run.
  if (withheldResult !== null) {
    emit(withheldResult);
    withheldResult = null;
  }

  // `--replay-user-messages` is always on, so the CLI echoes every line it takes off
  // stdin. It is the only mark on this stream that says which input is being worked on.
  emit({
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });

  // Taken up and then silent: the replay above is the only thing this turn ever says.
  if (silentFirst && turn === 1) return;

  if (args.has('--recovery-edit')) {
    writeFileSync(`.awos-recovery-edit-${turn}.txt`, `correction ${turn}\n`, 'utf8');
  }

  if (!sentInit) {
    sentInit = true;
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

  const thinking = args.has('--think') || args.has('--think-omit-final');
  const omitThinkingFromFinal = args.has('--think-omit-final');
  // The stream uses raw content-block indices. The omitted-thinking variant keeps the
  // text at index 1 in the stream, then removes thinking from the final payload so the
  // final text arrives at index 0, matching the production wire shape.
  const textIndex = thinking ? 1 : 0;
  let thinkingText = '';

  if (thinking) {
    emit({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    });

    const chunks = [
      'Let me look at what was asked. ',
      'The request is: ',
      text.slice(0, ECHO_CHARS),
      '. I should check the obvious places first, ',
      'then decide whether a tool call is warranted.',
    ];
    for (const chunk of chunks) {
      thinkingText += chunk;
      emit({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: chunk },
        },
        parent_tool_use_id: null,
        session_id: SESSION_ID,
      });
      // Longer than the text pause on purpose: the UI times the block from its first
      // delta, and a duration that rounds to zero proves nothing.
      if (args.has('--slow')) await sleep(400);
    }

    emit({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    });
  }

  emit({
    type: 'stream_event',
    event: { type: 'content_block_start', index: textIndex, content_block: { type: 'text' } },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });

  const chunks = args.has('--markdown')
    ? markdownChunks(text)
    : ['Working', ' on: ', text.slice(0, ECHO_CHARS)];

  for (const chunk of chunks) {
    emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: chunk },
      },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    });
    if (args.has('--slow')) await sleep(5);
  }

  emit({
    type: 'stream_event',
    event: { type: 'content_block_stop', index: textIndex },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });

  const finalText = chunks.join('');
  emit({
    type: 'assistant',
    message: {
      id: messageId,
      role: 'assistant',
      model: 'claude-fake-1',
      content: thinking && !omitThinkingFromFinal
        ? [
            { type: 'thinking', thinking: thinkingText },
            { type: 'text', text: finalText },
          ]
        : [{ type: 'text', text: finalText }],
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

  const result = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: finalText,
    duration_ms: 42,
    num_turns: turn,
    total_cost_usd: 0.001,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
    session_id: SESSION_ID,
  };

  if (turn === 1) {
    if (dropResult || stallSecond) return;
    if (lateResult) {
      withheldResult = result;
      return;
    }
  }

  emit(result);
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
  let arrived: (() => void) | null = null;

  /** Resolves once another input is queued behind the one being held. */
  const nextInput = (): Promise<void> =>
    queue.length > 0 ? Promise.resolve() : new Promise<void>((resolve) => (arrived = resolve));

  const drain = async (): Promise<void> => {
    if (running) return;
    running = true;
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) continue;
      // The second input is read but not acted on, so nothing at all is said about it
      // until a third turn is in flight. The adapter's only clue that it ever ran is the
      // replay it emits at that point, long after its own deadline passed.
      if (stallSecond && turn === 1) await nextInput();
      await runTurn(next);
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
      const waiter = arrived;
      arrived = null;
      waiter?.();
      void drain();
    }
  });

  // Closing stdin is how the harness asks for a clean exit.
  process.stdin.on('end', () => process.exit(0));
}

main();
