// Move every version in the repository at once.
//
// A release version lives in four places that must agree: the workspace root, the desktop
// workspace, the Tauri config that stamps the installer, and the crate the installer is
// built from. Tauri compares the running app's version against the update manifest, so a
// single file left behind means an app that either never updates or updates in a loop.
//
//   node scripts/set-version.mjs 0.2.0
//
// The tag is the release; this only makes the sources say the same thing.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/set-version.mjs <major.minor.patch>');
  process.exit(1);
}

/** Rewrite the first `"version": "..."` in a JSON file, leaving formatting untouched. */
function setJsonVersion(relative) {
  const path = join(root, relative);
  const before = readFileSync(path, 'utf8');
  const pattern = /"version":\s*"[^"]*"/;
  // Matching, not changing, is what proves the field was found — re-running with the
  // version already in place has to stay a no-op rather than an error.
  if (!pattern.test(before)) throw new Error(`${relative}: no version field found`);
  writeFileSync(path, before.replace(pattern, `"version": "${version}"`));
  return relative;
}

/** Rewrite the `version` in the crate manifest's `[package]` table only. */
function setCargoVersion(relative) {
  const path = join(root, relative);
  const before = readFileSync(path, 'utf8');
  const pattern = /(\[package\][^[]*?\nversion = ")[^"]*(")/;
  if (!pattern.test(before)) throw new Error(`${relative}: no version field found`);
  writeFileSync(path, before.replace(pattern, `$1${version}$2`));
  return relative;
}

/**
 * Keep the lockfile in step.
 *
 * Cargo would fix this on the next build, but leaving it stale means the release build is
 * the thing that produces a dirty tree, which reads as a broken checkout in CI.
 */
function setCargoLockVersion(relative) {
  const path = join(root, relative);
  const before = readFileSync(path, 'utf8');
  const after = before.replace(
    /(name = "agentic-work-os"\nversion = ")[^"]*(")/,
    `$1${version}$2`,
  );
  writeFileSync(path, after);
  return relative;
}

const changed = [
  setJsonVersion('package.json'),
  setJsonVersion('apps/desktop/package.json'),
  setJsonVersion('apps/desktop/src-tauri/tauri.conf.json'),
  setCargoVersion('apps/desktop/src-tauri/Cargo.toml'),
  setCargoLockVersion('apps/desktop/src-tauri/Cargo.lock'),
];

console.log(`version ${version}\n${changed.map((file) => `  ${file}`).join('\n')}`);
