# Agentic Work OS

One conversation, three worker profiles. Claude Code, OpenAI Codex, and Qwen Code share a
single thread — any profile can take the next turn, and the one picking up gets the full
transcript replayed into its own session.

Claude and Codex keep their native sessions on disk; Qwen sessions are resumed through the
Qwen Code SDK. The harness keeps the canonical transcript.
The harness keeps the canonical transcript. Either half can be lost without losing the
conversation.

```
┌─────────────────────────────────────────────┐
│ Tauri shell  →  React + shadcn UI           │
└──────────────────┬──────────────────────────┘
                   │ WebSocket (loopback + token)
┌──────────────────▼──────────────────────────┐
│ Node core: orchestrator, store, replay      │
│  ├── claude-code-cli → claude -p            │
│  ├── codex-app-server → codex app-server    │
│  └── qwen-code-sdk → local OpenAI-compatible │
└─────────────────────────────────────────────┘
```

Claude and Codex use their CLIs directly; Qwen Code uses the pinned SDK. Qwen detects an
existing local llama.cpp endpoint but never manages its lifecycle.

---

## Install

Windows installer, from the [latest release](https://github.com/sockulags/agentic-work-os/releases/latest):

```
https://github.com/sockulags/agentic-work-os/releases/latest/download/awos-setup.exe
```

The installer carries its own Node runtime, so the app itself needs nothing installed
first. The agent CLIs are a separate matter — the harness drives `claude` and `codex`
through your own logins, so those still have to be on PATH for a turn to run.

Updates are silent. The app checks 30 seconds after start and every four hours after
that, downloads a newer version in the background, and installs it when you close the
window — never in the middle of a turn. Each update is verified against the release
signing key compiled into the app, so a tampered or misrouted download is rejected
before it runs.

Building from source needs the requirements below; installing does not.

## Requirements

- **Node 22+**
- **Claude Code CLI** — `claude` on PATH (or set `AWOS_CLAUDE_BIN`)
- **Codex CLI** — `codex` on PATH (or set `AWOS_CODEX_BIN`)
- **Qwen Code SDK** — installed with `@awos/core`; local inference is detected at
  `http://127.0.0.1:1234/v1` by default
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
| `AWOS_CLAUDE_TURN_TIMEOUT_MS` | `600000` | Hard timeout for one Claude turn; a `result` that never arrives fails the turn instead of wedging the thread |
| `AWOS_CODEX_TURN_TIMEOUT_MS` | `600000` | Hard timeout for one Codex turn; a completion that never arrives fails the turn instead of wedging the thread |
| `AWOS_QWEN_BASE_URL` | `http://127.0.0.1:1234/v1` | Existing OpenAI-compatible endpoint; never started or stopped by AWOS |
| `AWOS_QWEN_MODEL` | `qwen3.8-27b-local` | Qwen model id |
| `AWOS_QWEN_API_KEY` | `local-placeholder` | OpenAI-compatible auth value passed to Qwen Code |
| `AWOS_QWEN_BIN` | *(SDK default)* | Optional Qwen Code executable override |
| `AWOS_QWEN_TURN_TIMEOUT_MS` | `600000` | Hard timeout for one Qwen turn |
| `AWOS_PORT` | `4319` | WebSocket port |
| `AWOS_TOKEN` | *(random)* | Shared secret; the dev script pins it to `dev-token` |
| `AWOS_REPLAY_MAX_CHARS` | `24000` | Ceiling on a replay block |
| `AWOS_REPLAY_MAX_TOOL_OUTPUT` | `800` | Per-tool output truncation inside replay |
| `AWOS_LANE_SETUP` | *(none)* | Fallback lane setup command for directories with no workspace declaration |
| `AWOS_LANE_SETUP_TIMEOUT_MS` | `600000` | How long that command may run when the workspace does not say |
| `AWOS_GH_BIN` | `gh` | GitHub CLI used to read work items as you |
| `AWOS_GH_BIN_ARGS` | `[]` | JSON array injected before its own args |
| `AWOS_GH_TIMEOUT_MS` | `20000` | How long one `gh` call may take before it counts as unreachable |
| `AWOS_APPROVAL_TIMEOUT_MS` | `600000` | Unanswered approvals auto-deny after this |
| `AWOS_LOG_LEVEL` | `info` | `debug` traces every protocol message |

## The project workspace

Those variables describe the machine the harness runs on. What the *project* needs — which
agents may work in it, how a fresh checkout is made usable, what verifying it means — is
declared by the repository itself, in `.awos/workspace.json`, committed alongside the code:

```json
{
  "version": 1,
  "name": "agentic-work-os",
  "repository": { "root": ".", "github": "sockulags/agentic-work-os" },
  "agents": ["claude", "codex", "qwen-local"],
  "setup": { "command": "npm install" },
  "verify": [
    { "name": "typecheck", "command": "npm run typecheck" },
    { "name": "test", "command": "npm test" }
  ],
  "context": {
    "references": ["ARCHITECTURE.md"],
    "notes": "Anything an agent should know before its first edit."
  }
}
```

Opening any directory inside the project finds it — resolution walks up to the nearest
declaration — and the **Workspace** tab in the dock shows the result, where each value came
from, and anything that failed to validate or points at a file that is not there. Every
turn carries a summary of it into the prompt, so both agents work to the same rules without
being told them again.

It can also require that named checks have passed before an agent's lane work is applied to
your directory:

```json
"integration": { "requires": ["typecheck", "test"], "allowOverride": false }
```

The check is run in the lane, its result is recorded against the exact working tree it ran
against, and integration is refused if a required check is missing, failed, or passed
against different content — the case an instruction in a prompt cannot catch, because the
tests really did pass, just not on this. Nothing is applied to your directory when the gate
refuses. An override exists only if the project turns one on, and it records who did it and
why, beside what it went around.

The schema is closed: a setting it does not know is an error, which is what keeps
credentials out of a file meant to be committed. Values that are true only on your machine
go in `.awos/local/workspace.json`, which is not committed and overrides the shared file
field by field. Named `verify` commands are declared here for later gates to reference;
nothing runs them for you yet.

## Working an issue

A thread can point at a GitHub issue. Paste a URL, `owner/name#14`, or just `#14` — a bare
number is resolved against the repository the workspace declares — and the **Work** tab
shows the issue, what has been run against it, and what each run was given.

The issue is read through your own `gh` CLI. The harness never asks for a token, never
stores one, and has none to lose; whatever your `gh` is logged into is what it can see. The
four ways that fails — not logged in, no such issue, rate limited, offline — each say which
one it was and what to do about it.

Every turn in the thread carries the issue in its context. **Start work** does more: it
records a *run* — which agent took it, which revision of the issue it read, and the exact
payload it was handed, verbatim. That record is an event in the log like everything else,
which is what makes it survive a restart and what makes it honest: an appended event cannot
be rewritten, so refreshing the issue later reports that the source has moved instead of
quietly changing what a finished run was asked to do.

GitHub stays the owner of the issue. Nothing here writes back to it, and the local copy is
a cache of what the source said, not an editable second version of it.

### Closing a run

A run that ended without a protocol error has not thereby done the work. So a run can be
closed with an outcome — delivered, partly done, blocked, abandoned — and a sentence saying
what actually came of it. That claim is somebody's, attributed to them, and it is separate
from how the turn ended.

**Evidence** is what supports it. Point at a command the run ran, the diff it produced, an
artifact it published, an approval you gave — the panel offers them, so you are pointing at
the fact rather than retelling it — or paste a URL for something only true outside the
harness. Each item records the commit and working tree it applies to, because "the tests
passed" means something different when the tree matched no commit.

**What was learned** is kept against the work item: a discovery, a decision, a constraint, an
open question. Tick the ones later runs should be told, untick the rest, retire the ones that
turned out to be wrong — nothing is deleted, and none of it edits the GitHub issue. A second
thread on the same issue starts with what the first one established.

Agents keep things the same way they publish artifacts — by writing a file. A line of JSON in
`.awos/retained.jsonl` (`{"kind":"decision","text":"…"}`) is picked up when the turn ends and
attributed to the agent that wrote it.

Corrections are appends. Restating an outcome or unticking a note leaves the earlier version
in the log, in order, with its author and its time.

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

When a thread outgrows the budget, older turns are shortened rather than dropped. A
shortened turn is marked `· brief` and keeps what the next turn can be wrong about — the
ask, the decision, the commands and their exit codes, every failure — and loses the prose
and the tool output:

```
### codex · brief
**codex:** Chose Postgres over SQLite because two processes write concurrently. …
  `npm run migrate` → error
```

The newest turn is always sent in full. Turns are dropped outright only when even the
brief forms overflow, which at the default budget takes about a hundred of them. See
[ARCHITECTURE.md §4](./ARCHITECTURE.md) for why the floor exists.

## Running both agents at once

By default the two agents share the thread's directory, so only one may work at a time —
two processes editing the same files is a race, not a feature. **Lanes** lift that: each
agent gets its own `git worktree` of the same repository, and both can run at the same
time. Turn them on with the **Lanes** button in the thread header.

```
your repo/            ← yours; nothing lands here until you say so
~/.awos/threads/<id>/lanes/claude    ← Claude's checkout
~/.awos/threads/<id>/lanes/codex     ← Codex's checkout
```

A lane starts from your working tree, uncommitted changes included — not from the last
commit — so an agent never redoes work you can already see. Nothing is committed on your
behalf and no branch appears in your repo.

When a lane has something you want, press its button in the header to integrate. It applies
all of the lane's work to your directory or none of it: a patch that collides is refused
with the reason, leaving your files exactly as they were, and can be retried once you have
resolved the collision. Both the integration and the refusal go into the transcript.

If the workspace requires checks, the **Work** tab shows where each one stands for each
lane, with a button to run it there. A lane that has not passed them is refused before
anything is applied.

Two things to know. A worktree only holds what git tracks, so `node_modules` and build
output are not in a fresh lane and its agent cannot run the tests until they are — that is
what `setup.command` in the workspace declaration is for. And switching lanes on
or off restarts both agents, which costs a full replay into their new sessions; the harness
refuses to switch off while a lane still holds work you have not integrated.

## Approvals

Codex raises approvals natively over its JSON-RPC channel. Claude has no callback channel
for a CLI host, so the harness ships a one-tool MCP server and passes
`--permission-prompt-tool`; that server dials back into the core over loopback TCP and
blocks until you decide. Both paths surface as the same dialog.

To skip approvals entirely, set the thread's permission mode to **Bypass** or
**Accept edits** in the header. Mode changes apply the next time an agent process starts,
since the mode is baked into its argv.

## Artifacts

When an agent makes something worth looking at rather than reading — a plan, a diagram, a
table, a screenshot — it writes a file into `.awos/artifacts/` inside the working
directory. The harness watches that directory and publishes each write as an event, so it
shows up in the side dock.

```
.awos/artifacts/
  release-plan.md      # markdown
  data-flow.mmd        # mermaid
  bench.csv            # csv
  screenshot.png       # image
```

There is no tool to call and nothing to configure: the agent uses the file-write tool it
already has, which is what makes this work identically for Claude and Codex. Tell it the
convention and it publishes — a line like *"put anything worth rendering into
`.awos/artifacts/` as markdown or mermaid"* in your prompt or `CLAUDE.md` is the whole
setup. The kind comes from the extension; markdown takes its title from the first heading,
everything else from the file name.

Because artifacts are ordinary files, they are also inspectable, diffable and committable,
and the agent can read back what it published on a later turn. Rewriting a file updates the
artifact in place, deleting it retires the artifact, and files over 1 MB are skipped rather
than truncated. Hidden files and editor scratch files (`.tmp`, `~`) are ignored, so an
in-flight save never appears as an artifact of its own. See
[ARCHITECTURE.md §9](./ARCHITECTURE.md) for the reasoning.

## Development

```bash
npm run typecheck     # tsc across all packages
npm test              # 604 tests: core (node:test) + ui (vitest)
npm run build         # protocol → core → ui
```

The integration tests run both adapters against fake CLIs that speak the real wire
formats (`packages/core/src/testing/`), so protocol regressions surface without burning
tokens or needing either CLI installed. On the UI side, vitest covers the two pieces of
pure logic that fail silently rather than loudly: the event-to-transcript fold and the
diff parser.

### Releasing

```bash
npm run version:set 0.2.0     # writes the version into all four files that must agree
git commit -am "Release 0.2.0"
git tag v0.2.0 && git push origin main v0.2.0
```

The tag triggers `.github/workflows/release.yml`, which runs the same typecheck and test
gate as `main`, builds the installer on `windows-latest`, signs it, and publishes the
release with `latest.json` for the updater plus a stable `awos-setup.exe` name so the
download link in this README never rots.

Two repository secrets have to exist for the signing step: `TAURI_SIGNING_PRIVATE_KEY`
and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, holding the minisign key generated by
`npx tauri signer generate`. The matching public key is committed in `tauri.conf.json`.
Losing the private key means shipped apps can no longer be updated — every existing
install would have to be replaced by hand — so it belongs in a password manager, not
only on one machine.

The installer is unsigned in the Authenticode sense, so Windows SmartScreen warns on
first install. That is cosmetic to the update path: Tauri verifies each update against
the compiled-in public key, which is a stronger guarantee than an untrusted certificate
would give.

`npm run desktop:build` produces the same installer locally, with two Windows caveats
worth knowing before trusting a local artifact:

- **Build with the MSVC toolchain.** A `x86_64-pc-windows-gnu` build links, bundles and
  installs without complaint, and the installed binary then dies in the loader on
  `api-ms-win-core-winrt-error-l1-1-0.dll`. If rustup's default is a gnu toolchain, build
  with `RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc`. CI is unaffected: `windows-latest`
  with `dtolnay/rust-toolchain@stable` is MSVC already.
- **On a nightly toolchain** the build needs `CARGO_UNSTABLE_BUILD_DIR_NEW_LAYOUT=false`,
  the same flag `npm run desktop` already sets, because `tauri-build` cannot find its
  generated resources under the new cargo build-directory layout.

To try an installer without touching a real install location, NSIS takes
`/S /D=C:\some\path` for a silent install, and the `uninstall.exe` it leaves behind takes
`/S` to remove both the directory and its registry entry.

## Layout

```
packages/protocol   types only, zero deps — HarnessEvent, both wire formats, UI↔core RPC
packages/core       adapters, thread store, replay, orchestrator, ws server, approval MCP
apps/ui             React + Tailwind + shadcn-style components
apps/desktop        Tauri shell (~150 LOC of Rust)
```

## Known limits

- One turn in flight per thread while the agents share a directory. Turn on lanes and each
  gets its own worktree, which is what makes running both at once safe.
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
- **Windows is the only packaged target.** `bundle.targets` is `nsis`, and the release
  workflow runs on `windows-latest` only. The shell itself is portable and `tauri build`
  works on macOS and Linux if you change the target, but nothing verifies that, and the
  updater manifest published today names one platform.
