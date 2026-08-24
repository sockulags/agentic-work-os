// Fetch a Node runtime for the packaged desktop app to carry.
//
// The Tauri shell spawns the core with Node. During development that is whatever `node`
// resolves to on PATH, which is fine because a contributor already has one. A packaged
// app cannot assume that: on a clean machine the app would start, fail to spawn, and
// show "Is Node on PATH?" instead of a window. So the bundle carries its own runtime.
//
// Windows publishes a bare `node.exe` per version, which keeps this to a single download
// with no archive handling. The other platforms only publish tarballs, so those go
// through `tar`, which ships with macOS and every Linux that can build this app anyway.
//
// The download is cached in `.cache/node-runtime/` so a rebuild is free, and the version
// is pinned here rather than taken from `process.version`: the runtime that ships must be
// reproducible from the repository, not a property of whoever ran the build.

import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

/** Pinned so the shipped runtime is a property of the repository, not of the build host. */
export const NODE_VERSION = '22.22.2';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheRoot = join(root, '.cache', 'node-runtime');

/** Node's own naming for the platform triple; only these three are buildable targets. */
function platformTriple() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return { os: 'win', arch, exe: 'node.exe' };
  if (process.platform === 'darwin') return { os: 'darwin', arch, exe: 'node' };
  if (process.platform === 'linux') return { os: 'linux', arch, exe: 'node' };
  throw new Error(`vendor-node: unsupported platform ${process.platform}`);
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`vendor-node: ${url} returned ${response.status}`);
  mkdirSync(dirname(destination), { recursive: true });
  await pipeline(response.body, createWriteStream(destination));
}

/**
 * Resolve a Node binary for this platform, downloading it once into the cache.
 *
 * Returns the path to the executable. The caller decides where it ends up in the bundle.
 */
export async function vendorNode() {
  const { os, arch, exe } = platformTriple();
  const cached = join(cacheRoot, `${NODE_VERSION}-${os}-${arch}`, exe);
  // A zero-length file means a download died halfway; treating it as a hit would ship a
  // broken runtime, so only a non-empty file counts.
  if (existsSync(cached) && statSync(cached).size > 0) return cached;

  rmSync(dirname(cached), { recursive: true, force: true });

  if (os === 'win') {
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/win-${arch}/node.exe`;
    console.log(`vendor-node: downloading ${url}`);
    await download(url, cached);
    return cached;
  }

  const name = `node-v${NODE_VERSION}-${os}-${arch}`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.gz`;
  console.log(`vendor-node: downloading ${url}`);
  const archive = join(cacheRoot, `${name}.tar.gz`);
  await download(url, archive);
  mkdirSync(dirname(cached), { recursive: true });
  // `--strip-components=2` drops `node-v.../bin/`, leaving the binary at the cache root.
  execFileSync('tar', ['-xzf', archive, '-C', dirname(cached), '--strip-components=2', `${name}/bin/node`]);
  rmSync(archive, { force: true });
  return cached;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('vendor-node.mjs')) {
  vendorNode().then(
    (path) => console.log(`vendor-node: ready at ${path}`),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
