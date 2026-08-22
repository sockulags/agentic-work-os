import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessEvent } from '@awos/protocol';
import { Orchestrator } from './orchestrator.js';
import { MAX_ARTIFACT_BYTES } from './store/artifact-store.js';
import type { HarnessConfig } from './config.js';

/**
 * The artifact pipeline, end to end through the orchestrator.
 *
 * What matters here is not that a watcher fires — it is that a file an agent wrote lands
 * in `events.jsonl` as a normal event. Everything downstream (persistence, replay after a
 * restart, delivery to a connected UI) is inherited from that one fact, so the assertions
 * are made against the transcript on disk rather than against the emitter.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, 'testing', 'fake-claude.js');
const FAKE_CODEX = join(here, 'testing', 'fake-codex.js');

let dataDir: string;
let cwd: string;
let orchestrator: Orchestrator | null = null;

function makeConfig(): HarnessConfig {
  return {
    dataDir,
    claudeBin: process.execPath,
    codexBin: process.execPath,
    claudeBinArgs: [FAKE_CLAUDE],
    codexBinArgs: [FAKE_CODEX],
    claudeModel: '',
    codexModel: '',
    host: '127.0.0.1',
    port: 0,
    replayMaxChars: 24_000,
    replayMaxToolOutput: 800,
    interruptGraceMs: 1_000,
    approvalTimeoutMs: 5_000,
    codexInitTimeoutMs: 10_000,
    laneSetup: '',
    laneSetupTimeoutMs: 60_000,
  };
}

async function boot(config: HarnessConfig): Promise<Orchestrator> {
  const orch = new Orchestrator(config);
  await orch.start();
  orchestrator = orch;
  return orch;
}

/** The events actually on disk, which is the only record that survives a restart. */
function persisted(threadId: string): HarnessEvent[] {
  const path = join(dataDir, 'threads', threadId, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as HarnessEvent);
}

function artifacts(threadId: string): Array<Extract<HarnessEvent, { kind: 'artifact.updated' }>> {
  return persisted(threadId).filter(
    (event): event is Extract<HarnessEvent, { kind: 'artifact.updated' }> =>
      event.kind === 'artifact.updated',
  );
}

/** Poll until the transcript satisfies `check`, rather than sleeping a guessed interval. */
async function until(label: string, check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Settle: long enough for a sweep that should not happen to prove it did not. */
async function quiet(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

function publish(name: string, content: string): void {
  const dir = join(cwd, '.awos', 'artifacts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content, 'utf8');
}

/** Materialize the live thread; the watcher starts with it. */
function open(orch: Orchestrator, threadId: string): void {
  orch.state(threadId);
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'awos-artifacts-data-'));
  cwd = mkdtempSync(join(tmpdir(), 'awos-artifacts-cwd-'));
});

afterEach(async () => {
  await orchestrator?.stop();
  orchestrator = null;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe('artifact pipeline', () => {
  test('turns published files into events on the canonical transcript', async () => {
    const orch = await boot(makeConfig());
    const thread = orch.createThread({ cwd });
    open(orch, thread.id);

    publish('plan.md', '# Release plan\n\nShip it.\n');
    publish('flow.mmd', 'graph TD;\n  A-->B;\n');
    publish('rows.json', '{"ok":true}\n');

    await until('three artifacts', () => artifacts(thread.id).length >= 3);

    const byId = new Map(artifacts(thread.id).map((event) => [event.artifactId, event]));
    const plan = byId.get('plan.md');
    assert.equal(plan?.artifactKind, 'markdown');
    assert.equal(plan?.title, 'Release plan');
    assert.match(plan?.content ?? '', /Ship it\./);
    assert.equal(plan?.path, join(cwd, '.awos', 'artifacts', 'plan.md'));

    assert.equal(byId.get('flow.mmd')?.artifactKind, 'mermaid');
    assert.equal(byId.get('flow.mmd')?.content, 'graph TD;\n  A-->B;\n');
    assert.equal(byId.get('rows.json')?.artifactKind, 'json');
    assert.equal(byId.get('rows.json')?.title, 'Rows');

    // Harness-level, not adapter-level: nothing here knows which agent wrote the file,
    // and no turn was in flight.
    assert.equal(plan?.agent, null);
    assert.equal(plan?.turnId, null);
    // The store owns ordering for artifacts exactly as it does for agent events.
    const seqs = artifacts(thread.id).map((event) => event.seq);
    assert.deepEqual([...seqs].sort((a, b) => a - b), seqs);
  });

  test('ignores dotfiles, save debris and oversize files', async () => {
    const orch = await boot(makeConfig());
    const thread = orch.createThread({ cwd });
    open(orch, thread.id);

    publish('.secret.md', '# Hidden');
    publish('draft.md.tmp', '# Half written');
    publish('huge.md', 'x'.repeat(MAX_ARTIFACT_BYTES + 1));
    publish('real.md', '# Real');

    await until('the real artifact', () => artifacts(thread.id).length >= 1);
    await quiet();

    assert.deepEqual(
      artifacts(thread.id).map((event) => event.artifactId),
      ['real.md'],
    );
  });

  test('a rewrite supersedes; an identical write says nothing', async () => {
    const orch = await boot(makeConfig());
    const thread = orch.createThread({ cwd });
    open(orch, thread.id);

    publish('plan.md', '# Plan\n\nfirst\n');
    await until('first version', () => artifacts(thread.id).length >= 1);

    publish('plan.md', '# Plan\n\nsecond\n');
    await until('second version', () => artifacts(thread.id).length >= 2);

    publish('plan.md', '# Plan\n\nsecond\n');
    await quiet();

    const events = artifacts(thread.id);
    assert.equal(events.length, 2, 'an unchanged rewrite must not spam the transcript');
    assert.match(events[1]?.content ?? '', /second/);
  });

  test('a deleted artifact is retired with an empty-content tombstone', async () => {
    const orch = await boot(makeConfig());
    const thread = orch.createThread({ cwd });
    open(orch, thread.id);

    publish('plan.md', '# Plan\n');
    await until('published', () => artifacts(thread.id).length >= 1);

    rmSync(join(cwd, '.awos', 'artifacts', 'plan.md'));
    await until('tombstone', () => artifacts(thread.id).length >= 2);

    const last = artifacts(thread.id).at(-1);
    assert.equal(last?.artifactId, 'plan.md');
    assert.equal(last?.content, '');
  });

  test('an artifact that grows past the ceiling is not retired', async () => {
    const orch = await boot(makeConfig());
    const thread = orch.createThread({ cwd });
    open(orch, thread.id);

    publish('plan.md', '# Plan\n');
    await until('published', () => artifacts(thread.id).length >= 1);

    // Unpublishable, but still very much on disk. A tombstone here would tell every
    // consumer the document was deleted, and the last good version would be gone.
    publish('plan.md', `# Plan\n${'x'.repeat(MAX_ARTIFACT_BYTES)}`);
    await quiet();

    assert.equal(artifacts(thread.id).length, 1, 'an unreadable file is not a deleted file');
  });

  test('an empty file publishes nothing, restart after restart', async () => {
    const config = makeConfig();
    const orch = await boot(config);
    const thread = orch.createThread({ cwd });
    open(orch, thread.id);

    // Empty content is how a deletion is spelled, so an empty file cannot be published as
    // itself: consumers would fold it as deleted, and since the fold retires tombstoned
    // ids, the next boot sweep would emit the same event again — once per restart, forever.
    publish('draft.md', '');
    await quiet();
    assert.equal(artifacts(thread.id).length, 0, 'an empty file is not a document yet');

    await orch.stop();
    orchestrator = null;

    const revived = await boot(config);
    open(revived, thread.id);
    await quiet();
    assert.equal(artifacts(thread.id).length, 0, 'and it stays silent across restarts');
  });

  test('emptying a published artifact retires it exactly once', async () => {
    const config = makeConfig();
    const orch = await boot(config);
    const thread = orch.createThread({ cwd });
    open(orch, thread.id);

    publish('plan.md', '# Plan\n');
    await until('published', () => artifacts(thread.id).length >= 1);

    publish('plan.md', '');
    await until('tombstone', () => artifacts(thread.id).length >= 2);
    assert.equal(artifacts(thread.id).at(-1)?.content, '');

    await orch.stop();
    orchestrator = null;

    const revived = await boot(config);
    open(revived, thread.id);
    await quiet();
    assert.equal(artifacts(thread.id).length, 2, 'the retired id does not come back');
  });

  test('picks up the directory when it is created after the thread opens', async () => {
    const orch = await boot(makeConfig());
    const thread = orch.createThread({ cwd });
    open(orch, thread.id);

    // No `.awos` at all yet — the watcher has nothing but the working directory.
    assert.equal(existsSync(join(cwd, '.awos')), false);
    await quiet();

    publish('late.md', '# Late arrival\n');
    await until('late artifact', () => artifacts(thread.id).length >= 1);
    assert.equal(artifacts(thread.id)[0]?.title, 'Late arrival');
  });

  test('a restart republishes nothing it already recorded', async () => {
    const config = makeConfig();
    const orch = await boot(config);
    const thread = orch.createThread({ cwd });
    open(orch, thread.id);

    publish('plan.md', '# Plan\n');
    await until('published', () => artifacts(thread.id).length >= 1);
    await orch.stop();
    orchestrator = null;

    const revived = await boot(config);
    open(revived, thread.id);
    await quiet();
    assert.equal(artifacts(thread.id).length, 1, 'unchanged files stay silent across a restart');

    // Written while the harness was down: the boot sweep is what catches it.
    publish('offline.md', '# Written while down\n');
    await until('offline artifact', () => artifacts(thread.id).length >= 2);
    assert.equal(artifacts(thread.id).at(-1)?.artifactId, 'offline.md');
  });

  test('a deletion recorded before a restart does not repeat itself', async () => {
    const config = makeConfig();
    const orch = await boot(config);
    const thread = orch.createThread({ cwd });
    open(orch, thread.id);

    publish('plan.md', '# Plan\n');
    await until('published', () => artifacts(thread.id).length >= 1);
    rmSync(join(cwd, '.awos', 'artifacts', 'plan.md'));
    await until('tombstone', () => artifacts(thread.id).length >= 2);

    await orch.stop();
    orchestrator = null;

    const revived = await boot(config);
    open(revived, thread.id);
    await quiet();
    assert.equal(artifacts(thread.id).length, 2, 'a tombstone retires the id for good');
  });
});
