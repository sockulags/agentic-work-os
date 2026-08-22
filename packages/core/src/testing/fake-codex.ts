#!/usr/bin/env node
/**
 * A fake `codex app-server` for integration tests.
 *
 * Implements the real handshake (initialize → initialized → thread/start) and the real
 * turn notification sequence, including a server→client approval request when asked, so
 * the adapter's JSON-RPC correlation and inbound-request handling are genuinely
 * exercised.
 *
 * Usage: fake-codex.js app-server [--tool] [--approval] [--diff]
 */

import { LineDecoder } from '../util/jsonl.js';

const args = new Set(process.argv.slice(2));

/**
 * How much of the prompt the fake echoes back.
 *
 * The echo is how a test sees what actually landed on the wire. Twenty characters was
 * enough when a prompt was the user's message; standing context blocks — workspace, work
 * item, pinned notes — now sit in front of it, and a window that narrow can only ever show
 * the first of them.
 */
const ECHO_CHARS = 600;

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

/**
 * The patch `--diff` reports, covering every file status a unified diff can express and
 * spanning more than one directory.
 *
 * A single modified file was enough to prove the event reaches the UI, but not enough to
 * exercise anything the UI does with it: file grouping, per-file counts, and the
 * added/deleted/renamed/binary branches of the viewer all collapse to one case when the
 * fixture has one file. Rendering bugs in those branches would go unseen end to end.
 */
const TURN_DIFF = [
  'diff --git a/src/lib.rs b/src/lib.rs',
  'index 1a2b3c4..5d6e7f8 100644',
  '--- a/src/lib.rs',
  '+++ b/src/lib.rs',
  '@@ -1,2 +1,2 @@',
  '-let old = 1;',
  '+let updated = 2;',
  'diff --git a/src/net/client.rs b/src/net/client.rs',
  'index 2b3c4d5..6e7f8a9 100644',
  '--- a/src/net/client.rs',
  '+++ b/src/net/client.rs',
  '@@ -10,6 +10,7 @@ impl Client {',
  '     pub fn connect(&self) -> Result<()> {',
  '         self.handshake()?;',
  '-        self.poll()',
  '+        self.poll()?;',
  '+        Ok(())',
  '     }',
  ' }',
  'diff --git a/src/net/retry.rs b/src/net/retry.rs',
  'new file mode 100644',
  'index 0000000..3c4d5e6',
  '--- /dev/null',
  '+++ b/src/net/retry.rs',
  '@@ -0,0 +1,4 @@',
  '+pub fn backoff(attempt: u32) -> u64 {',
  '+    let base = 100;',
  '+    base << attempt.min(6)',
  '+}',
  'diff --git a/src/legacy.rs b/src/legacy.rs',
  'deleted file mode 100644',
  'index 4d5e6f7..0000000',
  '--- a/src/legacy.rs',
  '+++ /dev/null',
  '@@ -1,3 +0,0 @@',
  '-pub fn unused() {',
  '-    todo!()',
  '-}',
  'diff --git a/docs/readme.md b/docs/guide.md',
  'similarity index 82%',
  'rename from docs/readme.md',
  'rename to docs/guide.md',
  'index 5e6f7a8..9b0c1d2 100644',
  '--- a/docs/readme.md',
  '+++ b/docs/guide.md',
  '@@ -1,2 +1,2 @@',
  '-# Readme',
  '+# Guide',
  ' Run the thing.',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 6f7a8b9..0c1d2e3 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  '',
].join('\n');

/**
 * Set by `turn/interrupt`, so a slow turn stops instead of finishing anyway.
 *
 * Without it an interrupted turn would report `interrupted` and then `completed` a moment
 * later, which no real agent does and which would let a test pass on the wrong event.
 */
let interrupted = false;

async function runTurn(threadId: string, text: string): Promise<void> {
  turnCounter += 1;
  interrupted = false;
  const turnId = `turn_${turnCounter}`;

  emit({ method: 'turn/started', params: { turn: { id: turnId, threadId } } });

  // Long enough for a test to interrupt mid-turn, short enough not to pad the suite.
  if (args.has('--slow')) {
    await sleep(400);
    if (interrupted) return;
  }

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
    emit({ method: 'turn/diff/updated', params: { turnId, diff: TURN_DIFF } });
  }

  const itemId = `item_msg_${turnCounter}`;
  for (const delta of ['Codex ', 'handled: ', text.slice(0, ECHO_CHARS)]) {
    emit({ method: 'item/agentMessage/delta', params: { itemId, delta } });
    await sleep(1);
  }

  emit({
    method: 'item/completed',
    params: { item: { id: itemId, type: 'agentMessage', text: `Codex handled: ${text.slice(0, ECHO_CHARS)}` } },
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
          interrupted = true;
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
