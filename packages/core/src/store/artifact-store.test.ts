import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_ARTIFACT_BYTES,
  artifactKindFor,
  artifactsDir,
  deletedArtifact,
  isArtifactCandidate,
  listArtifactFiles,
  readArtifact,
} from './artifact-store.js';

/**
 * The derivation rules an agent never states out loud.
 *
 * Publishing is a file write, so kind, title and identity are all inferred. These tests
 * pin the inference, because getting it wrong shows up as a panel labelled `tmp-3` or a
 * mermaid chart rendered as prose — wrong in a way that looks like a UI bug.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awos-artifact-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): void {
  writeFileSync(join(dir, name), content, 'utf8');
}

describe('artifact kinds', () => {
  test('maps extensions the dock has a renderer for', () => {
    assert.equal(artifactKindFor('plan.md'), 'markdown');
    assert.equal(artifactKindFor('flow.mmd'), 'mermaid');
    assert.equal(artifactKindFor('report.HTML'), 'html');
    assert.equal(artifactKindFor('data.json'), 'json');
    assert.equal(artifactKindFor('rows.csv'), 'csv');
    assert.equal(artifactKindFor('shot.png'), 'image');
  });

  test('falls back to text rather than refusing an unknown extension', () => {
    assert.equal(artifactKindFor('trace.log'), 'text');
    assert.equal(artifactKindFor('NOTES'), 'text');
  });
});

describe('candidate filtering', () => {
  test('rejects the debris of a save in progress', () => {
    assert.equal(isArtifactCandidate('.hidden.md'), false);
    assert.equal(isArtifactCandidate('report.md.tmp'), false);
    assert.equal(isArtifactCandidate('report.md~'), false);
    assert.equal(isArtifactCandidate('#report.md#'), false);
    assert.equal(isArtifactCandidate('.swp'), false);
  });

  test('accepts an ordinary published file', () => {
    assert.equal(isArtifactCandidate('release-plan.md'), true);
  });

  test('listing a directory that does not exist is empty, not an error', () => {
    assert.deepEqual(listArtifactFiles(join(dir, 'nope')), []);
  });

  test('subdirectories are not artifacts', () => {
    mkdirSync(join(dir, 'nested'));
    write('flat.md', '# Flat');
    assert.deepEqual(listArtifactFiles(dir), ['flat.md']);
    assert.equal(readArtifact(dir, 'nested'), null);
  });
});

describe('reading an artifact', () => {
  test('titles markdown from its first heading', () => {
    write('notes.md', '\n## Release plan\n\nbody text\n');
    assert.equal(readArtifact(dir, 'notes.md')?.title, 'Release plan');
  });

  test('falls back to the file name when there is no heading', () => {
    write('release_plan.md', 'no heading here');
    assert.equal(readArtifact(dir, 'release_plan.md')?.title, 'Release plan');
  });

  test('a heading inside a json artifact is not mistaken for a title', () => {
    write('data.json', '{"note": "# not a heading"}');
    assert.equal(readArtifact(dir, 'data.json')?.title, 'Data');
  });

  test('carries content, path and the file mtime', () => {
    write('flow.mmd', 'graph TD;\n  A-->B;\n');
    const body = readArtifact(dir, 'flow.mmd');
    assert.equal(body?.artifactKind, 'mermaid');
    assert.equal(body?.artifactId, 'flow.mmd');
    assert.equal(body?.content, 'graph TD;\n  A-->B;\n');
    assert.equal(body?.path, join(dir, 'flow.mmd'));
    assert.ok((body?.updatedAt ?? 0) > 0);
  });

  test('images arrive as a data uri so the event is self-contained', () => {
    writeFileSync(join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const body = readArtifact(dir, 'shot.png');
    assert.equal(body?.artifactKind, 'image');
    assert.equal(body?.content, `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`);
  });

  test('skips a file past the size ceiling instead of truncating it', () => {
    write('huge.md', 'x'.repeat(MAX_ARTIFACT_BYTES + 1));
    assert.equal(readArtifact(dir, 'huge.md'), null);
  });

  test('a missing file is null, not a throw', () => {
    assert.equal(readArtifact(dir, 'gone.md'), null);
  });
});

describe('deletion', () => {
  test('produces a tombstone that keeps the id and empties the content', () => {
    const body = deletedArtifact(dir, 'plan.md');
    assert.equal(body.artifactId, 'plan.md');
    assert.equal(body.content, '');
    assert.equal(body.artifactKind, 'markdown');
  });
});

describe('location', () => {
  test('hangs off the thread working directory', () => {
    assert.equal(artifactsDir(join('/repo')), join('/repo', '.awos', 'artifacts'));
  });
});
