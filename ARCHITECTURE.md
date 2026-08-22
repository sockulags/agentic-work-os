# Agentic Work OS — Architecture

A lightweight harness that drives **Claude Code CLI** and **OpenAI Codex** in a single
conversation thread. Either agent can take the next turn. Each keeps its own native
session on disk; the harness keeps the canonical transcript and replays it across the
boundary so a switch never loses context.

---

## 1. Design constraints

These came out of the protocol research and shaped everything below.

| Constraint | Consequence |
| --- | --- |
| Both agents are **long-lived child processes speaking newline-delimited JSON over stdio** | One adapter shape fits both. No HTTP, no SDK dependency. |
| Codex speaks **JSON-RPC 2.0** (`initialize` → `thread/start` → `turn/start`) | Adapter needs request/response correlation by `id`, plus notification handling. |
| Claude CLI speaks a **flat event stream** (`system`/`assistant`/`user`/`stream_event`/`result`) | Adapter is a pure event translator; no id correlation except for control requests. |
| Claude CLI has **no callback channel for approvals** — the documented path is `--permission-prompt-tool <mcp tool>` | The harness ships its own MCP server whose only job is to relay approval requests back to the UI. |
| Codex delivers approvals as a **server→client JSON-RPC request** (`item/permissions/requestApproval`) | Adapter must be able to *respond* to inbound requests, not just send them. |
| Agents are **stateful per process** | One process per (thread × agent). Processes are lazy — spawned on first turn for that agent. |

The asymmetry in approvals is the single largest source of complexity. It is fully
contained in the adapters; everything above them sees one `approval.requested` event.

---

## 2. Process topology

```
┌──────────────────────────────────────────────────────────────┐
│ Tauri shell (Rust, ~150 LOC)                                 │
│  · spawns the core sidecar, owns the window                  │
│  └── WebView ──► apps/ui (React + shadcn)                    │
└────────────────────────────┬─────────────────────────────────┘
                             │ WebSocket (127.0.0.1, random port + token)
┌────────────────────────────▼─────────────────────────────────┐
│ packages/core  — headless Node daemon                        │
│  · Orchestrator     one live Thread per conversation         │
│  · ThreadStore      canonical JSONL transcript on disk       │
│  · ReplayBuilder    cross-agent context handoff              │
│  · PermissionBridge TCP rendezvous for the approval MCP      │
│  ├── ClaudeAdapter ──► claude -p --input-format stream-json  │
│  │                      └── mcp: harness-permissions ────┐   │
│  └── CodexAdapter  ──► codex app-server                  │   │
└──────────────────────────────────────────────────────────┼───┘
                                                           │
                        approval relay over 127.0.0.1 TCP ─┘
```

The core is a standalone daemon on purpose. `npm run dev` runs it plus a Vite server, so
the whole app is debuggable in a normal browser with normal devtools. Tauri is only a
shell — swapping it for Electron, or shipping the core as a remote service, touches no
adapter code.

---

## 3. The normalized event model

Everything the UI renders is a `HarnessEvent`. Both adapters translate into it and never
leak their native shapes upward.

```ts
type HarnessEvent = {
  id: string;          // uuid
  seq: number;         // monotonic per thread — the canonical ordering
  threadId: string;
  agent: AgentId;      // 'claude' | 'codex'
  turnId: string | null;
  ts: number;
} & HarnessEventBody;
```

`HarnessEventBody` is a discriminated union on `kind`:

| `kind` | Emitted when | Claude source | Codex source |
| --- | --- | --- | --- |
| `turn.started` | user input accepted | first `system/init` or replayed user msg | `turn/started` |
| `turn.completed` | agent finished | `result` | `turn/completed` |
| `message.delta` | assistant text streaming | `stream_event` → `text_delta` | `item/agentMessage/delta` |
| `message.completed` | assistant text final | `assistant` msg text block | `item/completed` (agentMessage) |
| `reasoning.delta` | thinking tokens | `stream_event` → `thinking_delta` | `item/reasoning/delta` |
| `tool.started` | tool/command invoked | `assistant` msg `tool_use` block | `item/started` (commandExecution, fileChange, …) |
| `tool.output` | incremental stdout/stderr | — (Claude batches) | `exec/outputDelta` |
| `tool.completed` | tool returned | `user` msg `tool_result` block | `item/completed` |
| `plan.updated` | todo/plan changed | `TodoWrite` tool input | `turn/plan/updated` |
| `diff.updated` | turn's cumulative patch | — (no equivalent) | `turn/diff/updated` |
| `artifact.updated` | file written under `.awos/artifacts/` | harness file watcher | harness file watcher |
| `approval.requested` | permission gate | MCP relay | `item/permissions/requestApproval` |
| `approval.resolved` | user decided | — | — |
| `usage` | token accounting | `result.usage` | `turn/completed.usage` |
| `agent.status` | spawn/ready/exit/error | process lifecycle | process lifecycle |
| `error` | anything failed | `result.subtype=error_*` | JSON-RPC `error` |

Two rules keep this honest:

1. **Adapters never invent events.** If Codex reports incremental command output and
   Claude doesn't, Claude simply emits no `tool.output`. The UI degrades, it doesn't lie.
2. **`seq` is assigned by the store, not the adapter.** It is the single ordering
   authority across two concurrent processes.

---

## 4. Cross-agent handoff — full replay

The chosen model: **the harness owns the canonical log; each agent's native session is a
cache that may be stale.**

Every thread tracks a high-water mark per agent:

```
thread.watermark = { claude: 47, codex: 12 }
```

When agent *A* is asked to take a turn, `ReplayBuilder` collects every event with
`seq > watermark[A]` that agent *A* did not itself produce, and renders it into a
transcript block prepended to the user's message:

```
<harness-replay>
While you were away, the user worked with **codex** (3 turns).

### codex · turn 11
user: refactor the auth middleware
codex: I split `authenticate()` into `verifyToken()` and `loadSession()`.
  ⎿ ran: cargo test --package auth        → exit 0
  ⎿ edited: src/auth/mod.rs (+42 −17)

### codex · turn 12
...
</harness-replay>

Now: add rate limiting to the same middleware.
```

Then `watermark[A]` advances to the current head.

**Why prepend to the user message rather than use native injection.** Codex exposes
`thread/inject` for exactly this; Claude CLI has no equivalent. Using one mechanism for
both means one code path, one renderer, one set of tests, and no chance of the two agents
receiving materially different context. `thread/inject` is a future optimization, noted in
`replay.ts`, not a v1 requirement.

**Cost.** Replay is a real token cost on every switch, which is the trade-off you accepted
over summarization. Two mitigations are built in:

- Tool output is truncated to `REPLAY_MAX_TOOL_OUTPUT` (default 800 chars) with a
  `[… N lines elided]` marker — the fact that a command ran and its exit code matter more
  than its full stdout.
- `REPLAY_MAX_CHARS` (default 24 000) caps the whole block.

Both are config, not hardcoded, so you can tune toward fidelity or toward cost.

**Fitting the budget — two tiers.** Once the watermark advances, a turn that did not make
it into the block is not deferred, it is gone: that agent will never be shown it. A single
budget makes the oldest turns the ones that vanish, and those are where the decisions the
newer turns rest on were made. So every turn is rendered twice — in full, and in a **brief**
form that keeps who asked for what, what the agent decided, which tools ran and how they
exited, while dropping message bodies past 240 chars and all tool output.

The brief is the floor. Turns are admitted as briefs first, newest-first; the leftover
budget then upgrades them back to full, also newest-first. The newest turn is always full,
since it is the one the user's new message continues from. Failed tool calls are never
dropped from a brief — a later turn that assumes a command succeeded is the exact failure
this tier exists to prevent — while surplus successful ones collapse into a count.

Only what will not fit even as a brief is elided, and the header still says how many. A
brief runs a few hundred chars against a few thousand, so at the default budget elision
takes roughly a hundred turns to reach rather than a handful. Nothing here reads the
transcript back: both tiers are pure functions of events already in the log.

---

## 5. Approvals

### Codex — native
The app-server issues a JSON-RPC **request** (`item/permissions/requestApproval`) and
blocks the turn until the client responds. The adapter parks the request id in a pending
map, emits `approval.requested`, and answers when `approval.resolved` comes back from the
UI.

### Claude — via a harness-owned MCP server
Claude CLI's documented non-interactive approval hook is
`--permission-prompt-tool <mcp_tool_name>`. So the core:

1. Starts a **PermissionBridge** — a TCP listener on 127.0.0.1 with a one-time token.
2. Launches Claude with an inline `--mcp-config` registering a stdio server
   (`packages/core/src/permission-mcp/main.ts`) exposing one tool,
   `mcp__harness_permissions__request_permission`, with the bridge port and token in env.
3. Claude spawns that MCP server as its own child. When Claude wants permission, it calls
   the tool. The tool connects to the bridge, forwards
   `{threadId, toolName, input, toolUseId}`, and blocks.
4. The core emits `approval.requested`; the UI shows a dialog; the decision travels back
   down the bridge.
5. The tool returns the contract Claude expects:
   `{"behavior":"allow","updatedInput":{…}}` or `{"behavior":"deny","message":"…"}`.

The indirection is unavoidable — Claude spawns its MCP servers itself, so the only way to
reach back into the core is a socket rendezvous.

> **Escape hatch.** Set `permissionMode: 'acceptEdits'` or `'bypassPermissions'` per thread
> and the bridge stays idle. The approval path is opt-in, not load-bearing for a first run.

---

## 6. Session identity and persistence

| | Claude | Codex |
| --- | --- | --- |
| Native session id | UUID we generate, passed as `--session-id`; `--resume <id>` after | `thread.id` from `thread/start`; `thread/resume` after |
| Where it lives | `~/.claude/projects/**` | Codex's own store |
| Harness record | `threads/<id>/meta.json` → `{ nativeSessions: { claude, codex } }` | same |

The canonical transcript is `threads/<id>/events.jsonl`, append-only, one `HarnessEvent`
per line. The store is crash-safe by construction: restart replays the file to rebuild
in-memory state, and native sessions are re-attached on the next turn, not at boot.

Nothing in the harness ever writes into an agent's own session storage. If the harness DB
is deleted, both agents still have their full native histories; if an agent's session is
gone, the harness rebuilds context from the canonical log by replaying it into a fresh
session. Either half can be lost without losing the conversation.

---

## 7. Concurrency

- **One turn in flight per thread.** Sending to Codex while Claude is mid-turn is
  rejected by the orchestrator rather than queued, because the two would race on the
  filesystem. The UI disables the composer for the duration.
- **Interrupts** map to `turn/interrupt` (Codex) and a `control_request`/`interrupt`
  on stdin (Claude), with a SIGTERM fallback after `INTERRUPT_GRACE_MS`.
- **Multiple threads** run fully in parallel — each owns its own process pair.

---

## 8. Package layout

```
packages/protocol   pure types, zero deps — HarnessEvent, both wire formats, UI↔core RPC
packages/core       adapters, store, replay, orchestrator, ws server, permission MCP
apps/ui             React + Tailwind + shadcn-style components, Vite
apps/desktop        Tauri shell
```

`protocol` has no runtime dependencies and is imported by everything, so a wire-format
change is a compile error in every consumer rather than a runtime surprise.

---

## 9. Artifacts — publishing by writing a file

An agent that produces something worth *looking at* rather than reading in the transcript —
a table, a diagram, a rendered report — publishes it by writing a file into
`<thread.cwd>/.awos/artifacts/`. The core watches that directory and emits
`artifact.updated`; the side dock renders it.

**Why a file convention and not a tool.** A tool would have to be registered with each
agent separately, and the two are not symmetric there: only Claude gets an
`--mcp-config`, and only for the permission bridge. Codex would need its own mechanism,
and the harness would then own two publishing paths that can drift. A file needs neither:
both agents already have a write tool, no adapter learns anything, nothing new can fail at
spawn time, and the result is a real file on disk — inspectable, diffable, committable,
and readable by the agent that wrote it on its next turn. The trade is that the agent has
to be *told* the convention, which is a line in a prompt rather than a protocol change.

```
<thread.cwd>/.awos/artifacts/
  release-plan.md      → markdown
  data-flow.mmd        → mermaid
  bench.csv            → csv
  screenshot.png       → image (inlined as a data: URI)
```

The kind comes from the extension, since the writer has no channel to declare one;
unknown extensions render as text rather than being refused. Markdown titles itself from
its first heading, everything else from the file name.

**It goes through the ordinary event path.** The watcher hands the body to the same
`Thread#record` every adapter event passes through, so an artifact is persisted in
`events.jsonl`, gets its `seq` from the store, reaches connected UIs over the existing
socket, and survives a restart — none of which is code anyone had to write for it. The
events carry `agent: null`, because the watcher sees a file change and not an author;
`turnId` is best-effort attribution to whatever turn was in flight.

Four rules keep the directory from becoming a noise source:

- **Emission is keyed on content, not on file-system activity.** `fs.watch` fires several
  times per save, editors touch files they did not change, and every restart re-reads a
  directory the transcript already describes. The watcher hashes what it last published —
  seeded from the event log at thread open — so all three are silent.
- **Save debris is ignored**: dotfiles, `~` backups, and `.tmp`/`.swp`-class names, all of
  which appear in a watch the moment they are created and would otherwise each become an
  artifact of their own.
- **Files over 1 MB are skipped, not truncated.** The content is inlined into the event, so
  it is appended verbatim to the transcript on every write; and a truncated document looks
  like a broken renderer rather than a skipped file.
- **A deletion emits a tombstone** — the same event with empty content — rather than
  nothing. Consumers derive their state by folding an append-only log, so silence would
  leave the last `artifact.updated` standing as the newest word on that id and the
  artifact would return on the next restart.

The directory is watched from the thread's working directory down, so it does not need to
exist yet: until it appears the watcher sits on the nearest existing ancestor and moves
down when it is created.

---

## 10. What v1 deliberately does not do

- **Diff parity via working-tree snapshots.** Codex reports a cumulative turn diff via
  `turn/diff/updated`. Claude has no equivalent in the stream-json protocol: its
  `Edit`/`Write` results are prose confirmations, not patches. Rather than reconstruct a
  diff by parsing that prose — which would be wrong in ways the user cannot detect — the
  orchestrator captures the working tree with a throwaway-index git snapshot before and
  after any turn whose agent lacks a native diff (`capabilities.turnDiff === false`), and
  emits the delta as the same `diff.updated` event Codex produces (`util/git.ts`). Ground
  truth from the filesystem, never an interpretation of tool output. It is a no-op outside
  a git repository, and Codex is never shadowed since it reports its own.
- **No multi-agent parallelism inside one thread.** Two agents on the same working
  directory at the same time is a correctness problem, not a feature.
- **No summarization.** By your decision — full replay, and when the budget cannot hold it,
  the brief tier from §4. Both tiers are deterministic renderings of logged events; no
  model reads the transcript to compress it, so a replay never contains a claim no agent
  made.
- **No auth management.** Both CLIs use their own existing logins. The harness never sees
  a token.
