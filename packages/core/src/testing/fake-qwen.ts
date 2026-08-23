#!/usr/bin/env node
/**
 * A small Qwen Code SDK CLI stand-in for session-recovery integration tests.
 *
 * It implements the SDK control handshake, echoes the received prompt as one assistant
 * message, and can fail before execution in the same way the real CLI reports a missing
 * --resume session.
 */

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { LineDecoder } from '../util/jsonl.js';

const args = process.argv.slice(2);
const resumeIndex = args.indexOf('--resume');
const resumedSessionId = resumeIndex >= 0 ? args[resumeIndex + 1] ?? null : null;
const sessionIndex = args.indexOf('--session-id');
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] ?? 'qwen-fresh-session' : 'qwen-fresh-session';

appendFileSync(
  join(process.cwd(), '.awos-qwen-invocations.log'),
  `${JSON.stringify({ resume: resumedSessionId, sessionId })}\n`,
  'utf8',
);

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (resumedSessionId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
  process.stderr.write(
    `No saved session found with ID ${resumedSessionId}. Run \`qwen --resume\` without an ID to choose from existing sessions.\n`,
  );
  process.exit(1);
}

function promptText(message: { message?: { content?: string | Array<{ text?: string }> } }): string {
  const content = message.message?.content;
  if (typeof content === 'string') return content;
  return content?.map((block) => block.text ?? '').join('') ?? '';
}

function runTurn(prompt: string): void {
  if (prompt.includes('retry-but-fail')) {
    process.stderr.write('model transport failed after the fresh session started\n');
    process.exit(1);
  }

  const uuid = `qwen-${Date.now()}`;
  const content: unknown[] = [];
  if (prompt === 'prior-qwen-context') {
    content.push({
      type: 'tool_use',
      id: `${uuid}-tool`,
      name: 'read_file',
      input: { file_path: 'prior.txt' },
    });
  }
  content.push({ type: 'text', text: prompt === 'prior-qwen-context' ? 'prior-qwen-answer' : prompt });
  emit({
    type: 'system',
    subtype: 'init',
    uuid: `${uuid}-system`,
    session_id: sessionId,
    model: 'qwen-fake',
  });
  emit({
    type: 'assistant',
    uuid: `${uuid}-assistant`,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: `${uuid}-message`,
      type: 'message',
      role: 'assistant',
      model: 'qwen-fake',
      content,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  if (prompt === 'prior-qwen-context') {
    emit({
      type: 'user',
      uuid: `${uuid}-tool-result`,
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: `${uuid}-tool`,
          content: 'prior-qwen-tool-result',
          is_error: false,
        }],
      },
    });
  }
  emit({
    type: 'result',
    subtype: 'success',
    uuid: `${uuid}-result`,
    session_id: sessionId,
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: prompt,
    usage: { input_tokens: 1, output_tokens: 1 },
    permission_denials: [],
  });
}

const decoder = new LineDecoder();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  for (const line of decoder.push(chunk)) {
    let message: { type?: string; request_id?: string; message?: { content?: string | Array<{ text?: string }> } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      continue;
    }

    if (message.type === 'control_request') {
      emit({
        type: 'control_response',
        response: { subtype: 'success', request_id: message.request_id, response: {} },
      });
    } else if (message.type === 'user') {
      runTurn(promptText(message));
    }
  }
});

process.stdin.on('end', () => process.exit(0));
