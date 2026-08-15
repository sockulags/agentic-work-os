import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateWorkingDirectory } from './server.js';

test('validates that a working directory exists and is a directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'awos-cwd-'));
  const file = join(root, 'file.txt');
  writeFileSync(file, 'not a directory');

  try {
    await validateWorkingDirectory(root);
    await assert.rejects(
      validateWorkingDirectory(file),
      new Error(`Working directory does not exist or is not a directory: ${file}`),
    );

    const missing = join(root, 'missing');
    await assert.rejects(
      validateWorkingDirectory(missing),
      new Error(`Working directory does not exist or is not a directory: ${missing}`),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
