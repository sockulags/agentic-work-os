import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReleaseVersion, readVersionSources } from './set-version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function checkVersion(sourceRoot, tag, refType = 'tag') {
  if (refType !== 'tag') {
    return {
      ok: false,
      reason: 'release ref must be a tag',
    };
  }

  const version = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : null;
  if (version === null || !isReleaseVersion(version) || tag !== `v${version}`) {
    return {
      ok: false,
      reason: 'tag must match v<major.minor.patch[-pre]>',
    };
  }

  let sources;
  try {
    sources = readVersionSources(sourceRoot);
  } catch (error) {
    return {
      ok: false,
      reason: `could not read version sources: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const mismatches = sources.filter((source) => source.version !== version);
  if (mismatches.length > 0) {
    return {
      ok: false,
      reason: mismatches
        .map((source) => `${source.relative}=${source.version ?? '<missing>'}`)
        .join(', '),
    };
  }

  return { ok: true, version };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = checkVersion(root, process.argv[2], process.argv[3]);
  if (!result.ok) {
    console.error(`version check failed: ${result.reason}`);
    process.exitCode = 1;
  } else {
    console.log(`version ${result.version} matches all release sources`);
  }
}
