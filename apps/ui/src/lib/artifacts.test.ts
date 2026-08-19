import { describe, expect, it } from 'vitest';
import type { ArtifactKind, HarnessEvent } from '@awos/protocol';
import { foldArtifacts } from './artifacts';

let seq = 0;

function artifactEvent(
  artifactId: string,
  overrides: Partial<{ content: string; title: string; kind: ArtifactKind; updatedAt: number }> = {},
): HarnessEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    threadId: 't1',
    seq,
    ts: 1_700_000_000_000 + seq,
    agent: null,
    turnId: null,
    kind: 'artifact.updated',
    artifactId,
    title: overrides.title ?? artifactId,
    artifactKind: overrides.kind ?? 'markdown',
    content: overrides.content ?? '# hello',
    path: `/repo/.awos/artifacts/${artifactId}`,
    updatedAt: overrides.updatedAt ?? 1_700_000_000_000 + seq,
  };
}

function otherEvent(): HarnessEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    threadId: 't1',
    seq,
    ts: 1_700_000_000_000 + seq,
    agent: 'claude',
    turnId: null,
    kind: 'message.completed',
    itemId: `m${seq}`,
    text: 'unrelated',
  };
}

describe('foldArtifacts', () => {
  it('is empty for a log with no artifact events', () => {
    expect(foldArtifacts([otherEvent(), otherEvent()])).toEqual([]);
  });

  it('carries the event body through to the artifact', () => {
    const [artifact] = foldArtifacts([
      artifactEvent('report.md', { title: 'Quarterly report', updatedAt: 42 }),
    ]);

    expect(artifact).toEqual({
      id: 'report.md',
      title: 'Quarterly report',
      kind: 'markdown',
      content: '# hello',
      path: '/repo/.awos/artifacts/report.md',
      updatedAt: 42,
    });
  });

  it('keeps only the latest event per artifact id', () => {
    const artifacts = foldArtifacts([
      artifactEvent('report.md', { content: 'first', title: 'First' }),
      otherEvent(),
      artifactEvent('report.md', { content: 'second', title: 'Second' }),
    ]);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.content).toBe('second');
    expect(artifacts[0]?.title).toBe('Second');
  });

  it('removes an artifact whose latest event is a tombstone', () => {
    const artifacts = foldArtifacts([
      artifactEvent('gone.md'),
      artifactEvent('stays.md'),
      artifactEvent('gone.md', { content: '' }),
    ]);

    expect(artifacts.map((a) => a.id)).toEqual(['stays.md']);
  });

  it('brings an artifact back when it is rewritten after deletion', () => {
    const artifacts = foldArtifacts([
      artifactEvent('flaky.md', { content: 'v1' }),
      artifactEvent('flaky.md', { content: '' }),
      artifactEvent('flaky.md', { content: 'v2' }),
    ]);

    expect(artifacts.map((a) => a.content)).toEqual(['v2']);
  });

  it('ignores a tombstone for an artifact it never saw', () => {
    expect(foldArtifacts([artifactEvent('never.md', { content: '' })])).toEqual([]);
  });

  it('orders newest first, breaking ties on id', () => {
    const artifacts = foldArtifacts([
      artifactEvent('b.md', { updatedAt: 100 }),
      artifactEvent('c.md', { updatedAt: 300 }),
      artifactEvent('a.md', { updatedAt: 100 }),
    ]);

    expect(artifacts.map((a) => a.id)).toEqual(['c.md', 'a.md', 'b.md']);
  });

  it('reorders on rewrite so a freshly published artifact leads', () => {
    const artifacts = foldArtifacts([
      artifactEvent('old.md', { updatedAt: 500 }),
      artifactEvent('new.md', { updatedAt: 100 }),
      artifactEvent('new.md', { updatedAt: 900, content: 'rewritten' }),
    ]);

    expect(artifacts.map((a) => a.id)).toEqual(['new.md', 'old.md']);
  });

  it('preserves each artifact kind', () => {
    const artifacts = foldArtifacts([
      artifactEvent('a.csv', { kind: 'csv', updatedAt: 1 }),
      artifactEvent('b.mmd', { kind: 'mermaid', updatedAt: 2 }),
      artifactEvent('c.png', { kind: 'image', updatedAt: 3 }),
    ]);

    expect(artifacts.map((a) => a.kind)).toEqual(['image', 'mermaid', 'csv']);
  });
});
