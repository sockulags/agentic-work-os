#!/usr/bin/env node
/**
 * A fake `codex app-server` for integration tests.
 *
 * Implements the real handshake (initialize → initialized → thread/start) and the real
 * turn notification sequence, including a server→client approval request when asked, so
 * the adapter's JSON-RPC correlation and inbound-request handling are genuinely
 * exercised.
 *
 * Usage: fake-codex.js app-server [--tool] [--approval]
 */

import { LineDecoder } from '../util/jsonl.js';

const args = new Set(process.argv.slice(2));
const THREAD_ID = 'thr_fake_1';

let turnCounter = 0;
let approvalRpcId = 9000;

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves when the harness answers our approval request. */
const pendingApprovals = new Map<number, (decision: string) => void>();

async function runTurn(threadId: string, text: string): Promise<void> {
  turnCounter += 1;
  const turnId = `turn_${turnCounter}`;

  emit({ method: 'turn/started', params: { turn: { id: turnId, threadId } } });

  if (args.has('--tool')) {
    const itemId = `item_exec_${turnCounter}`;

    if (args.has('--approval')) {
      const rpcId = approvalRpcId++;
      const decision = await new Promise<string>((resolve) => {
        pendingApprovals.set(rpcId, resolve);
        emit({
          id: rpcId,
          method: 'item/permissions/requestApproval',
          params: { itemId, threadId, turnId, type: 'exec', command: ['echo', 'hi'], cwd: '/tmp' },
        });
      });

      if (decision === 'denied' || decision === 'abort') {
        emit({
          method: 'item/completed',
          params: { item: { id: itemId, type: 'commandExecution', status: 'aborted' } },
        });
        emit({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
        return;
      }
    }

    emit({
      method: 'item/started',
      params: { item: { id: itemId, type: 'commandExecution', command: ['echo', 'hi'] } },
    });
    emit({
      method: 'exec/outputDelta',
      params: { itemId, stream: 'stdout', chunk: 'hi\n' },
    });
    emit({
      method: 'item/completed',
      params: {
        item: { id: itemId, type: 'commandExecution', exitCode: 0, aggregatedOutput: 'hi\n' },
      },
    });
  }

  emit({
    method: 'turn/plan/updated',
    params: { plan: [{ step: 'inspect', status: 'completed' }, { step: 'apply', status: 'pending' }] },
  });

  if (args.has('--diff')) {
    emit({
      method: 'turn/diff/updated',
      params: {
        turnId,
        diff:
          'diff --git a/src/lib.rs b/src/lib.rs\n' +
          '--- a/src/lib.rs\n' +
          '+++ b/src/lib.rs\n' +
          '@@ -1,2 +1,2 @@\n' +
          '-let old = 1;\n' +
          '+let updated = 2;\n',
      },
    });
  }

  const itemId = `item_msg_${turnCounter}`;
  for (const delta of ['Codex ', 'handled: ', text.slice(0, 20)]) {
    emit({ method: 'item/agentMessage/delta', params: { itemId, delta } });
    await sleep(1);
  }

  emit({
    method: 'item/completed',
    params: { item: { id: itemId, type: 'agentMessage', text: `Codex handled: ${text.slice(0, 20)}` } },
  });

  emit({
    method: 'turn/completed',
    params: {
      turn: { id: turnId, status: 'completed', usage: { inputTokens: 50, outputTokens: 10 } },
    },
  });
}

function main(): void {
  const decoder = new LineDecoder();

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    for (const line of decoder.push(chunk)) {
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue;
      }

      // A response to our approval request carries no method.
      if (msg.method === undefined && msg.id !== undefined) {
        const waiter = pendingApprovals.get(msg.id);
        if (waiter) {
          pendingApprovals.delete(msg.id);
          const result = msg.result as { decision?: string } | undefined;
          waiter(result?.decision ?? 'denied');
        }
        continue;
      }

      switch (msg.method) {
        case 'initialize':
          emit({
            id: msg.id,
            result: { serverInfo: { name: 'fake-codex', version: '0.0.1' } },
          });
          break;

        case 'initialized':
          break;

        case 'thread/start':
          emit({ id: msg.id, result: { thread: { id: THREAD_ID } } });
          emit({ method: 'thread/started', params: { thread: { id: THREAD_ID } } });
          break;

        case 'thread/resume': {
          const requested = msg.params?.['threadId'];
          if (requested === 'stale-thread') {
            // Exercises the adapter's fall-back-to-new-thread path.
            emit({ id: msg.id, error: { code: -32000, message: 'thread not found' } });
            break;
          }
          emit({ id: msg.id, result: { thread: { id: String(requested) } } });
          break;
        }

        case 'turn/start': {
          emit({ id: msg.id, result: { turn: { id: `turn_${turnCounter + 1}` } } });
          const params = msg.params as { threadId: string; input: Array<{ text: string }> };
          void runTurn(params.threadId, params.input[0]?.text ?? '');
          break;
        }

        case 'turn/interrupt':
          emit({ id: msg.id, result: {} });
          emit({
            method: 'turn/completed',
            params: { turn: { id: `turn_${turnCounter}`, status: 'interrupted' } },
          });
          break;

        default:
          if (msg.id !== undefined) {
            emit({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
          }
      }
    }
  });

  process.stdin.on('end', () => process.exit(0));
}

main();
