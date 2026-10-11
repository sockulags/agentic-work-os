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

import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

/** Pinned so the shipped runtime is a property of the repository, not of the build host. */
export const NODE_VERSION = '22.22.2';

// Update these digests from https://nodejs.org/dist/v22.22.2/SHASUMS256.txt at the same time as NODE_VERSION.
export const NODE_ARTIFACT_DIGESTS = Object.freeze({
  'win-arm64/node.exe': '1a338f2467a566197ed8b309240a3a372f5d72458f9c7e5c9613ad6ccae1e0c0',
  'win-x64/node.exe': 'ae1a50511be58e987483fdbc12125407443926d2d394669ade2352776e920dd3',
  'node-v22.22.2-darwin-arm64.tar.gz': 'db4b275b83736df67533529a18cc55de2549a8329ace6c7bcc68f8d22d3c9000',
  'node-v22.22.2-darwin-x64.tar.gz': '12a6abb9c2902cf48a21120da13f87fde1ed1b71a13330712949e8db818708ba',
  'node-v22.22.2-linux-arm64.tar.gz': 'b2f3a96f31486bfc365192ad65ced14833ad2a3c2e1bcefec4846902f264fa28',
  'node-v22.22.2-linux-x64.tar.gz': '978978a635eef872fa68beae09f0aad0bbbae6757e444da80b570964a97e62a3',
});

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

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyFileDigest(filePath, expectedDigest) {
  const actualDigest = await sha256File(filePath);
  if (actualDigest !== expectedDigest) {
    rmSync(filePath, { force: true });
    throw new Error(
      `vendor-node: digest mismatch for ${filePath}; expected ${expectedDigest}, actual ${actualDigest}`,
    );
  }
  return actualDigest;
}

/**
 * Resolve a Node binary for this platform, downloading it once into the cache.
 *
 * Returns the path to the executable. The caller decides where it ends up in the bundle.
 */
export async function vendorNode() {
  const { os, arch, exe } = platformTriple();
  const cached = join(cacheRoot, `${NODE_VERSION}-${os}-${arch}`, exe);
  const artifact = os === 'win' ? `win-${arch}/node.exe` : `node-v${NODE_VERSION}-${os}-${arch}.tar.gz`;
  const expectedDigest = NODE_ARTIFACT_DIGESTS[artifact];
  if (!expectedDigest) throw new Error(`vendor-node: no pinned digest for ${artifact}`);

  if (os === 'win') {
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/win-${arch}/node.exe`;
    // A zero-length file means a download died halfway; treating it as a hit would ship a
    // broken runtime, so only a non-empty file counts.
    if (existsSync(cached) && statSync(cached).size > 0) {
      await verifyFileDigest(cached, expectedDigest);
      return cached;
    }

    rmSync(dirname(cached), { recursive: true, force: true });
    console.log(`vendor-node: downloading ${url}`);
    await download(url, cached);
    await verifyFileDigest(cached, expectedDigest);
    return cached;
  }

  const name = `node-v${NODE_VERSION}-${os}-${arch}`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.gz`;
  const archive = join(cacheRoot, `${name}.tar.gz`);
  if (existsSync(archive) && statSync(archive).size > 0) {
    await verifyFileDigest(archive, expectedDigest);
  } else {
    rmSync(dirname(cached), { recursive: true, force: true });
    console.log(`vendor-node: downloading ${url}`);
    await download(url, archive);
    await verifyFileDigest(archive, expectedDigest);
  }

  // Always derive the returned binary from the verified archive, including on cache hits.
  rmSync(dirname(cached), { recursive: true, force: true });
  mkdirSync(dirname(cached), { recursive: true });
  // `--strip-components=2` drops `node-v.../bin/`, leaving the binary at the cache root.
  execFileSync('tar', ['-xzf', archive, '-C', dirname(cached), '--strip-components=2', `${name}/bin/node`]);
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
