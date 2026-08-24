// Assemble a self-contained copy of the Node core for the packaged desktop app.
//
// The Tauri shell spawns the core with `node core/main.js` from the bundled resources.
// That directory therefore needs the core's runtime dependencies alongside it, or the
// process dies with "Cannot find module 'ws'". Rather than bundle everything into one
// file — which would move `import.meta.url` and break how the Claude adapter locates the
// permission MCP entry (adapters/ -> ../permission-mcp/main.js) — we keep the compiled
// `dist` layout byte-for-byte and drop the two runtime deps into a local node_modules:
//
//   dist-bundle/
//     main.js, adapters/, permission-mcp/, ...   (copied from dist, untouched)
//     node_modules/
//       ws/                 (pure JS, zero deps)
//       @awos/protocol/     (workspace package: its dist + package.json)
//     runtime/
//       node(.exe)          (pinned, vendored — see vendor-node.mjs)
//
// Node's module resolution walks up from core/main.js and finds the dependencies here,
// and the shell prefers the vendored runtime over whatever is on PATH, so a packaged app
// needs nothing installed on the machine.

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vendorNode } from './vendor-node.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreDist = join(root, 'packages', 'core', 'dist');
const protocolDist = join(root, 'packages', 'protocol', 'dist');
const wsPkg = join(root, 'node_modules', 'ws');
const out = join(root, 'packages', 'core', 'dist-bundle');

function require(path, hint) {
  if (!existsSync(path)) {
    console.error(`bundle-core: missing ${path}\n  ${hint}`);
    process.exit(1);
  }
}

require(join(coreDist, 'main.js'), 'Build the core first: npm run build');
require(join(protocolDist, 'index.js'), 'Build the protocol first: npm run build');
require(join(wsPkg, 'package.json'), 'Install dependencies first: npm install');

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

// 2. Runtime dependencies, resolvable from core/main.js.
const nm = join(out, 'node_modules');
cpSync(wsPkg, join(nm, 'ws'), { recursive: true });

const protocolOut = join(nm, '@awos', 'protocol');
mkdirSync(protocolOut, { recursive: true });
cpSync(protocolDist, join(protocolOut, 'dist'), { recursive: true });
cpSync(join(root, 'packages', 'protocol', 'package.json'), join(protocolOut, 'package.json'));

// 3. The Node runtime itself. Development still runs on PATH; only the bundle carries one.
const vendored = await vendorNode();
const runtime = join(out, 'runtime', basename(vendored));
mkdirSync(dirname(runtime), { recursive: true });
cpSync(vendored, runtime);
// cpSync preserves mode on POSIX, but the Windows download arrives without one.
chmodSync(runtime, 0o755);

console.log(`bundle-core: assembled self-contained core at ${out}`);
