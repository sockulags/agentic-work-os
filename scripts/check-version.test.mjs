import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkVersion } from './check-version.mjs';
import { readVersionSources } from './set-version.mjs';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(version = '1.2.3') {
  const root = mkdtempSync(join(tmpdir(), 'awos-version-check-'));
  roots.push(root);

  const files = {
    'package.json': JSON.stringify({ version }),
    'apps/desktop/package.json': JSON.stringify({ version }),
    'apps/desktop/src-tauri/tauri.conf.json': JSON.stringify({ version }),
    'apps/desktop/src-tauri/Cargo.toml': `[package]\nversion = "${version}"\n`,
    'apps/desktop/src-tauri/Cargo.lock': `[[package]]\nname = "agentic-work-os"\nversion = "${version}"\n`,
  };

  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  }

  return root;
}

describe('checkVersion', () => {
  test('accepts a matching release tag and all source versions', () => {
    assert.deepEqual(checkVersion(fixture(), 'v1.2.3'), { ok: true, version: '1.2.3' });
  });

  test('rejects a tag whose version differs from the source versions', () => {
    const result = checkVersion(fixture(), 'v1.2.4');

    assert.equal(result.ok, false);
    assert.match(result.reason, /package\.json/);
  });

  test('rejects malformed release tags', () => {
    const result = checkVersion(fixture(), '1.2.3');

    assert.equal(result.ok, false);
    assert.match(result.reason, /v<major\.minor\.patch/);
  });

  test('rejects one source left behind at an older version', () => {
    const root = fixture('1.2.4');
    writeFileSync(
      join(root, 'apps/desktop/src-tauri/Cargo.lock'),
      '[[package]]\nname = "agentic-work-os"\nversion = "1.2.3"\n',
      'utf8',
    );

    const result = checkVersion(root, 'v1.2.4');

    assert.equal(result.ok, false);
    assert.match(result.reason, /Cargo\.lock/);
  });

  test('CLI exits non-zero for a branch name and zero for the current sources', () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), 'check-version.mjs');
    const versions = readVersionSources();
    const version = versions[0].version;
    assert.ok(version);
    assert.ok(versions.every((source) => source.version === version));

    const matching = spawnSync(process.execPath, [script, `v${version}`], { encoding: 'utf8' });
    const branch = spawnSync(process.execPath, [script, 'main'], { encoding: 'utf8' });

    assert.equal(matching.status, 0, matching.stderr);
    assert.notEqual(branch.status, 0, branch.stderr);
  });
});
