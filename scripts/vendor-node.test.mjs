import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { verifyFileDigest } from './vendor-node.mjs';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(contents) {
  const root = mkdtempSync(join(tmpdir(), 'awos-node-digest-'));
  roots.push(root);
  const file = join(root, 'node-artifact');
  writeFileSync(file, contents);
  return file;
}

describe('verifyFileDigest', () => {
  test('accepts a matching artifact digest', async () => {
    const contents = Buffer.from('verified node artifact');
    const file = fixture(contents);
    const expected = createHash('sha256').update(contents).digest('hex');

    await assert.doesNotReject(verifyFileDigest(file, expected));
    assert.ok(existsSync(file));
  });

  test('deletes a mismatching artifact and reports both digests', async () => {
    const contents = Buffer.from('tampered node artifact');
    const file = fixture(contents);
    const expected = '0'.repeat(64);
    const actual = createHash('sha256').update(contents).digest('hex');

    await assert.rejects(
      verifyFileDigest(file, expected),
      (error) => {
        assert.match(error.message, new RegExp(`expected ${expected}`));
        assert.match(error.message, new RegExp(`actual ${actual}`));
        return true;
      },
    );
    assert.equal(existsSync(file), false);
  });
});
