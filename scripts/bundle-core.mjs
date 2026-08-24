// Assemble a self-contained copy of the Node core for the packaged desktop app.
//
// The Tauri shell spawns the core with `node core/main.js` from the bundled resources.
// That directory therefore needs the core's runtime dependencies alongside it, or the
// process dies with "Cannot find package". Rather than bundle everything into one file —
// which would move `import.meta.url` and break how the Claude adapter locates the
// permission MCP entry (adapters/ -> ../permission-mcp/main.js) — we keep the compiled
// `dist` layout byte-for-byte and place a local node_modules beside it:
//
//   dist-bundle/
//     main.js, adapters/, permission-mcp/, ...   (copied from dist, untouched)
//     node_modules/
//       @awos/protocol/     (workspace package: its dist + package.json)
//       ws/, @qwen-code/sdk/, ...  (the closure of core's runtime dependencies)
//     runtime/
//       node(.exe)          (pinned, vendored — see vendor-node.mjs)
//
// Node's module resolution walks up from core/main.js and finds the dependencies here,
// and the shell prefers the vendored runtime over whatever is on PATH, so a packaged app
// needs nothing installed on the machine.
//
// The dependency list is read from `packages/core/package.json` rather than written out
// here. It used to be hardcoded, and adding the Qwen adapter therefore produced a bundle
// that ran on a developer machine — where the workspace node_modules is one directory up —
// and died on a user's machine with a module it had never been given.

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vendorNode } from './vendor-node.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreDist = join(root, 'packages', 'core', 'dist');
const protocolDist = join(root, 'packages', 'protocol', 'dist');
const out = join(root, 'packages', 'core', 'dist-bundle');
const nodeModules = join(out, 'node_modules');

function require(path, hint) {
  if (!existsSync(path)) {
    console.error(`bundle-core: missing ${path}\n  ${hint}`);
    process.exit(1);
  }
}

function readPackage(path) {
  return JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
}

require(join(coreDist, 'main.js'), 'Build the core first: npm run build');
require(join(protocolDist, 'index.js'), 'Build the protocol first: npm run build');

// Start clean so a stale bundle never ships.
rmSync(out, { recursive: true, force: true });

// 1. The compiled core, layout preserved exactly — minus test artifacts, the fake CLIs
//    used only by tests, and source maps, none of which belong in a shipped app.
const isTestArtifact = (src) =>
  /\.test\.[cm]?js$/.test(src) ||
  /\.test\.d\.ts(\.map)?$/.test(src) ||
  /\.map$/.test(src) ||
  /[/\\]testing([/\\]|$)/.test(src);
cpSync(coreDist, out, { recursive: true, filter: (src) => !isTestArtifact(src) });

// 2. The workspace protocol package, which resolves through a symlink in development and
//    therefore has to be materialised rather than copied.
const protocolOut = join(nodeModules, '@awos', 'protocol');
mkdirSync(protocolOut, { recursive: true });
cpSync(protocolDist, join(protocolOut, 'dist'), { recursive: true });
cpSync(join(root, 'packages', 'protocol', 'package.json'), join(protocolOut, 'package.json'));

/**
 * Resolve an installed package the way Node would from the core's location: the hoisted
 * copy at the workspace root first, then nested inside the package that depends on it.
 */
function locate(name, dependent) {
  const nested = dependent === null ? null : join(dependent, 'node_modules', name);
  if (nested !== null && existsSync(nested)) return nested;
  const hoisted = join(root, 'node_modules', name);
  return existsSync(hoisted) ? hoisted : null;
}

// 3. The runtime dependency closure. Anything already materialised — protocol — is left
//    alone; anything missing is a hard error, because the alternative is discovering it
//    only once the app is installed on a machine without a workspace to fall back on.
const copied = new Set(['@awos/protocol']);

function copyClosure(names, dependent) {
  for (const name of names) {
    if (copied.has(name)) continue;
    const source = locate(name, dependent);
    if (source === null) {
      console.error(`bundle-core: cannot find ${name}\n  Install dependencies first: npm install`);
      process.exit(1);
    }
    copied.add(name);
    const destination = join(nodeModules, ...name.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    // Nested node_modules are re-resolved through this same walk, so copying them here
    // would only duplicate what the closure already places at the top level.
    cpSync(source, destination, {
      recursive: true,
      dereference: true,
      filter: (src) => !/[/\\]node_modules([/\\]|$)/.test(src.slice(source.length)),
    });
    copyClosure(Object.keys(readPackage(source).dependencies ?? {}), source);
  }
}

copyClosure(Object.keys(readPackage(join(root, 'packages', 'core')).dependencies ?? {}), null);

// 4. The Node runtime itself. Development still runs on PATH; only the bundle carries one.
const vendored = await vendorNode();
const runtime = join(out, 'runtime', basename(vendored));
mkdirSync(dirname(runtime), { recursive: true });
cpSync(vendored, runtime);
// cpSync preserves mode on POSIX, but the Windows download arrives without one.
chmodSync(runtime, 0o755);

console.log(
  `bundle-core: assembled self-contained core at ${out}\n` +
    `  packages: ${[...copied].sort().join(', ')}`,
);
