# Agentic Work OS

One conversation, two agents. Claude Code and OpenAI Codex share a single thread — either
can take the next turn, and the one picking up gets the full transcript replayed into its
own session, so it knows what the other just did.

Both agents keep their native sessions on disk (`~/.claude/projects`, Codex's own store).
The harness keeps the canonical transcript. Either half can be lost without losing the
conversation.

```
┌─────────────────────────────────────────────┐
│ Tauri shell  →  React + shadcn UI           │
└──────────────────┬──────────────────────────┘
                   │ WebSocket (loopback + token)
┌──────────────────▼──────────────────────────┐
│ Node core: orchestrator, store, replay      │
│  ├── claude -p --input-format stream-json   │
│  └── codex app-server  (JSON-RPC/stdio)     │
└─────────────────────────────────────────────┘
```

No Agent SDK: both adapters drive the CLIs directly over stdio, which is what makes them
symmetric. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the protocol details and the
reasoning behind each design decision.

---

## Requirements

- **Node 20.10+**
- **Claude Code CLI** — `claude` on PATH (or set `AWOS_CLAUDE_BIN`)
- **Codex CLI** — `codex` on PATH (or set `AWOS_CODEX_BIN`)
- **Rust toolchain** — only for the desktop shell. The browser dev loop needs nothing
  beyond Node. Install from [rustup.rs](https://rustup.rs); the Tauri CLI itself comes
  in as a devDependency, so there is nothing to install globally.

Both CLIs use their own existing logins. The harness never sees a token.

## Getting started

```bash
npm install
npm run build
npm run dev
```

`npm run dev` starts the core and Vite together. Open **http://localhost:5180** — the UI
runs in a normal browser with normal devtools, talking to the same daemon the desktop app
uses. This is the fastest loop and the one to reach for first.

For the desktop shell:

```bash
npm run desktop
```

That builds the core, then hands off to Tauri, which starts Vite and compiles the Rust
window. First run pays for a full Rust compile — several minutes — and needs the
[Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your
platform (WebView2 on Windows, `webkit2gtk` and `librsvg` on Linux).

### First run

1. Click **+** in the sidebar and enter a working directory — this is the repo the agents
   operate in.
2. Pick an agent above the composer and send a message.
3. Switch agents mid-thread whenever you like. The status dots next to each agent name
   show whether that CLI was found on PATH.

## Configuration

Every setting is an environment variable, read at core startup.

| Variable | Default | What it does |
| --- | --- | --- |
| `AWOS_DATA_DIR` | `~/.awos` | Where threads and transcripts live |
| `AWOS_CLAUDE_BIN` | `claude` | Claude Code executable |
| `AWOS_CODEX_BIN` | `codex` | Codex executable |
| `AWOS_CLAUDE_BIN_ARGS` | `[]` | JSON array injected before the harness's own args — put an agent behind a wrapper |
| `AWOS_CODEX_BIN_ARGS` | `[]` | Same, for Codex |
| `AWOS_CLAUDE_MODEL` | *(CLI default)* | Passed as `--model` |
| `AWOS_CODEX_MODEL` | *(CLI default)* | Passed to `thread/start` |
| `AWOS_PORT` | `4319` | WebSocket port |
| `AWOS_TOKEN` | *(random)* | Shared secret; the dev script pins it to `dev-token` |
| `AWOS_REPLAY_MAX_CHARS` | `24000` | Ceiling on a replay block |
| `AWOS_REPLAY_MAX_TOOL_OUTPUT` | `800` | Per-tool output truncation inside replay |
| `AWOS_APPROVAL_TIMEOUT_MS` | `600000` | Unanswered approvals auto-deny after this |
| `AWOS_LOG_LEVEL` | `info` | `debug` traces every protocol message |

## How the handoff works

The harness owns the canonical log; each agent's native session is a cache that may be
stale. Before an agent takes a turn, everything it hasn't seen is rendered into a
transcript block and prepended to your message:

```
<harness-replay>
While you were away, the user worked with **codex** (2 turns).
This is a transcript for context — it already happened, do not redo it.

### codex
**user:** refactor the auth middleware
  `cargo test --package auth`
    → exit 0
**codex:** Split authenticate() into verifyToken() and loadSession().
</harness-replay>

Now: add rate limiting to the same middleware.
```

Your transcript shows what you actually typed; the block is transport, not content.
Replay costs tokens on every switch — `AWOS_REPLAY_MAX_CHARS` and
`AWOS_REPLAY_MAX_TOOL_OUTPUT` are the dials.

## Approvals

Codex raises approvals natively over its JSON-RPC channel. Claude has no callback channel
for a CLI host, so the harness ships a one-tool MCP server and passes
`--permission-prompt-tool`; that server dials back into the core over loopback TCP and
blocks until you decide. Both paths surface as the same dialog.

To skip approvals entirely, set the thread's permission mode to **Bypass** or
**Accept edits** in the header. Mode changes apply the next time an agent process starts,
since the mode is baked into its argv.

## Development

```bash
npm run typecheck     # tsc across all packages
npm test              # 145 tests: core (node:test) + ui (vitest)
npm run build         # protocol → core → ui
```

The integration tests run both adapters against fake CLIs that speak the real wire
formats (`packages/core/src/testing/`), so protocol regressions surface without burning
tokens or needing either CLI installed. On the UI side, vitest covers the two pieces of
pure logic that fail silently rather than loudly: the event-to-transcript fold and the
diff parser.

## Layout

```
packages/protocol   types only, zero deps — HarnessEvent, both wire formats, UI↔core RPC
packages/core       adapters, thread store, replay, orchestrator, ws server, approval MCP
apps/ui             React + Tailwind + shadcn-style components
apps/desktop        Tauri shell (~150 LOC of Rust)
```

## Known limits

- One turn in flight per thread. Two agents on the same working directory concurrently is
  a correctness problem, not a feature.
- Claude batches tool output rather than streaming it, so command output appears on
  completion. Codex streams it live. The UI reflects the difference rather than faking it.
- Codex reports its own turn-level diff; for agents that don't (Claude), the harness
  synthesizes one from a git working-tree snapshot taken around the turn — ground truth,
  not a parse of the agent's tool output — and feeds it through the same `diff.updated`
  path, so the **Changes** panel renders both identically. The one requirement is that the
  working directory be a git repository; outside one, the panel falls back to explaining
  the absence as before. `.gitignore` is respected, so `node_modules` and build output
  never appear in the diff.
- Claude batches tool output rather than streaming it: the Claude CLI's stream-json
  protocol has no incremental tool-output channel, so command output arrives on
  completion while Codex streams it live. The UI reflects the difference rather than
  faking it — closing this needs a change on the CLI side, not in the harness.
- **`tauri build` is wired but unverified on a clean machine.** `npm run desktop` (dev)
  remains the fastest loop. For a distributable, `beforeBuildCommand` now builds the UI,
  builds the core, and assembles a self-contained core (`scripts/bundle-core.mjs` copies
  `packages/core/dist` plus its two runtime deps — `ws` and `@awos/protocol` — into
  `dist-bundle/`, which the bundle ships as `core/`), and a real icon set lives under
  `apps/desktop/src-tauri/icons/`. Node itself is still expected on PATH (already a
  project requirement); vendoring a Node binary or a `--experimental-sea-config` single
  executable is the remaining option if that assumption ever needs to go.
