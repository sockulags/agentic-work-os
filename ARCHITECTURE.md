# Agentic Work OS — Architecture

A lightweight harness that drives **Claude Code CLI**, **OpenAI Codex**, and **Qwen Code**
worker profiles in a single conversation thread. Either worker can take the next turn.
Each keeps its native session state; the harness keeps the canonical transcript and
replays it across the boundary so a switch never loses context.

---

## 1. Design constraints

These came out of the protocol research and shaped everything below.

| Constraint | Consequence |
| --- | --- |
| Worker adapters are stateful and own their native protocol boundary | One normalized adapter shape fits CLI and SDK transports; the static profile registry keeps target metadata separate from implementation ids. |
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
│  ├── ClaudeAdapter (claude-code-cli) ──► claude -p           │
│  │                      └── mcp: harness-permissions ────┐   │
│  ├── CodexAdapter (codex-app-server) ──► codex app-server│   │
│  └── QwenCodeAdapter (qwen-code-sdk) ──► @qwen-code/sdk │   │
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
  agent: AgentId;      // 'claude' | 'codex' | 'qwen-local'
  turnId: string | null;
  ts: number;
} & HarnessEventBody;
```

`HarnessEventBody` is a discriminated union on `kind`:

| `kind` | Emitted when | Claude source | Codex source |
| --- | --- | --- | --- |
| `turn.started` | user input accepted | first `system/init` or replayed user msg | `turn/started` |
| `turn.completed` | worker finished | `result` | `turn/completed`; Qwen result or timeout |
| `message.delta` | assistant text streaming | `stream_event` → `text_delta` | `item/agentMessage/delta` |
| `message.completed` | assistant text final | `assistant` msg text block | `item/completed` (agentMessage) |
| `reasoning.delta` | thinking tokens | `stream_event` → `thinking_delta` | `item/reasoning/delta` |
| `tool.started` | tool/command invoked | `assistant` msg `tool_use` block | `item/started` (commandExecution, fileChange, …) |
| `tool.output` | incremental stdout/stderr | — (Claude/Qwen batch) | `exec/outputDelta` |
| `tool.completed` | tool returned | `user` msg `tool_result` block | `item/completed` |
| `plan.updated` | todo/plan changed | `TodoWrite` tool input | `turn/plan/updated`; Qwen does not emit plans |
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

The limit was never the two agents; it was the one directory they share. So the thread has
two modes, and the mode decides how many turns can be in flight.

- **Shared directory (default).** One turn in flight per thread. Sending to Codex while
  Claude is mid-turn is rejected by the orchestrator rather than queued, because the two
  would race on the filesystem. The UI disables the composer for the duration.
- **Lanes (`parallel`).** Each agent gets its own `git worktree` of the same repository, so
  the turn lock becomes per agent and both can run at once. The UI disables only the lane
  you are sending to.
- **Interrupts** map to `turn/interrupt` (Codex) and a `control_request`/`interrupt`
  on stdin (Claude), with a SIGTERM fallback after `INTERRUPT_GRACE_MS`. With lanes,
  interrupting names one agent; without them there is only ever one to name.
- **Multiple threads** run fully in parallel — each owns its own process pair.

### Lanes

A lane is a detached worktree under `<dataDir>/threads/<id>/lanes/<agent>`, provisioned on
that agent's first turn. Detached, so no branch appears in the user's repo; and nothing is
ever committed on their behalf.

**Seeded from the working tree, not from `HEAD`.** `git worktree add` checks out a commit,
so a plain lane would miss whatever is uncommitted — usually the very work being continued.
The lane is checked out at `HEAD` and then the diff from `HEAD` to a snapshot of the
working tree is applied on top, which reuses the same snapshot machinery §9 uses for turn
diffs. What the agent sees is what the user sees.

**Integration is explicit, and all or nothing.** A lane's work reaches the thread directory
only when the user asks. The patch is checked with `git apply --check` before it is
applied, so a collision changes nothing rather than leaving conflict markers in files
nobody asked anyone to touch; the refusal is recorded and can be retried once the collision
is resolved. The lane's baseline advances only on success, so integrating twice is not
integrating twice. There is no merge commit and no branch — the transcript is the history,
and the lane is only where the files were while it was made.

**What lanes cost.** A worktree holds what git tracks, so files git ignores are not there —
for most repos `node_modules` and build output, which means an agent that can edit the
source but not run the tests. `setup.command` in the project's workspace declaration (§10)
names a command to run once in each new lane for exactly that. The harness does not guess
one: what makes a checkout usable is project knowledge it does not have, which is why it
asks the project rather than the machine.

Turning lanes on or off restarts both agents, because an adapter's working directory is
fixed when it spawns. Their native sessions go with them and the watermarks reset, so the
next turn replays the thread's full history into a fresh session — the rebuild §6 already
promises when a native session is lost. Leaving lanes is refused while one still holds work
that was never integrated, and a thread that closes with such a lane keeps it on disk and
says where: the alternative is deleting the only copy of something the user never saw.

---

## 8. Package layout

```
packages/protocol   pure types, zero deps — HarnessEvent, both wire formats, UI↔core RPC
packages/core       adapters, store, replay, workspace, work items, ledger, orchestrator, ws server, permission MCP
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

## 10. The project workspace contract

`HarnessConfig` (§8, `config.ts`) describes the **machine**: where the binaries are, which
port to bind, where threads are stored. All of it comes from `AWOS_*` environment
variables, because all of it is a property of the install.

None of that is where a *project's* rules belong. Which agents may work in a repository,
what makes a fresh checkout usable, what "verified" means here — those are properties of
the repository, they should be reviewed like code, and they should not have to be
rediscovered by every thread. So a repository declares them in `.awos/workspace.json`,
committed:

```json
{
  "version": 1,
  "name": "agentic-work-os",
  "repository": { "root": ".", "github": "sockulags/agentic-work-os" },
  "agents": ["claude", "codex"],
  "setup": { "command": "npm install", "timeoutMs": 600000 },
  "verify": [{ "name": "test", "command": "npm test" }],
  "context": { "references": ["ARCHITECTURE.md"], "notes": "…" }
}
```

**Resolved from a path, never from a thread.** `resolveWorkspace(cwd)` walks up to the
nearest declaration. Two threads in the same checkout get the same answer; a directory
that was never opened as a thread still resolves; and no stored thread carries a copy that
could go stale. That is also the whole migration story for existing threads: `ThreadSummary`
is unchanged, because there is nothing about a workspace to store on a thread.

**Read on every use, cached nowhere.** The declaration is a file in the repository, so a
pull, a branch switch, or an agent's own edit can change it between turns. Two small
synchronous reads cost less than a rule for when a cache is stale — the same reasoning as
the pinned notes in §4.

**Precedence runs in two tiers, and they point opposite ways.** Machine settings are
environment-first and the declaration cannot touch them. Project settings are
declaration-first: `.awos/local/workspace.json` (not committed) overrides the shared file
field by field, and `AWOS_LANE_SETUP` is consulted only where the project declares no
setup command. A repository that states how it installs should not be broken by a stale
export in someone's shell.

**The schema is closed.** An unknown key is an error rather than something ignored, which
is what keeps a committed file from becoming a place to put a token. Nothing in the schema
takes a credential, and the resolved workspace never reaches `events.jsonl` — like the
replay preamble, it is transport, rendered into the prompt and not into the log.

**Validation reports everything at once**, with the file, the path inside it, and a
sentence about the project rather than about the schema. Errors mean the workspace does not
resolve; warnings mean it resolved but something in it points at nothing, which the dock's
**Workspace** tab shows beside the effective values and their provenance.

---

## 11. Work items and runs

The workspace contract (§10) says what a project is. A **work item** says what a thread is
*for*: the external issue that authorized the work. The transcript records what was said and
done, which does not reconstruct the intent it was answering — which issue, which version of
it, and whether it has moved since.

**GitHub is read through the user's `gh`, not through a client of ours.** `gh` is already
authenticated, so the harness never asks for a token, never stores one, and has none to
leak; enterprise hosts and SSO come along without a line of code. The cost is a process per
call and a dependency on `gh` being installed, and the latter is treated as one of the
ordinary failures rather than as a crash. The boundary is shaped like the agent adapters —
a binary plus injectable arguments — so tests point it at a fake that speaks the same JSON.

**Four failures, four kinds.** Not logged in, no such issue, rate limited, offline. Each
needs a different move from the user, and a panel that answers "try again" to all of them is
wrong three times out of four.

**The item belongs to the workspace, not the thread.** An issue picked up again in a new
thread is the same issue, and deleting a thread must not delete the record of what it was
for. Threads point at items; nothing points back.

**A run is an event, not a register.** `run.started` carries the agent, the item, the source
revision, the instruction, and the composed context *verbatim* — a summary of what an agent
was given is not evidence of what it was given. `run.completed` carries the terminal state,
read back out of the log rather than tracked in a field, so it cannot disagree with the
transcript.

That choice is what makes refresh honest. Because an appended event cannot change, a later
refresh updates the item's own snapshot and nothing else; the UI compares the two revisions
and says the source has moved since a run. No rule has to be remembered, and no code path
exists that could rewrite the context of a run that already happened.

**Every turn carries the issue; only a run claims to be the work.** The issue is standing
truth about the thread, like the pinned notes. A run is an assertion that this particular
turn is the work the issue asked for, and it is recorded as such.

### Outcomes, evidence and retained context

A `turn.completed` with reason `completed` means an agent stopped without a protocol error.
Nothing in the log distinguishes that from having done the work, and the distinction is the
one every later decision rests on. Three more appended records carry it.

**An outcome** (`run.closed`) states what the run achieved — delivered, partial, blocked,
abandoned — with a sentence, attributed to whoever said it. Never inferred: the case this
exists for is an agent that exits cleanly having done the wrong thing.

**Evidence** (`evidence.recorded`) points at a fact rather than restating one. `ref.eventId`
names a command, diff, artifact or approval already in the log, so the evidence cannot drift
from what happened; `ref.url` covers what is only true outside the harness, and a person has
to vouch for those. Each item captures the commit and the working-tree hash it applies to,
taken from the agent's lane when it has one — a claim about code is a claim about a
particular tree, and a tree that has moved on since is what a reader needs to know.

**Retained context** (`context.retained`) keeps a discovery, decision, constraint or open
question against the work item rather than editing the issue GitHub owns. Selected items are
rendered into later runs' prompts as `<retained-context>`, attributed and marked as belief
rather than fact. The fold runs across every thread, because a work item outlives any one of
them.

**Corrections are appends.** All three folds take the last record carrying a given id, so the
current answer is one pass and every earlier claim is still there with its author and its
time. Amending a retained item is composed server-side from the current record, so ticking a
box cannot rewrite the words above it.

Nothing here is scored, ranked or inferred, and no model reads the ledger to decide whether
the work is done. That is the same line §4 draws around replay: the harness renders what was
recorded and never invents a claim nobody made.

### The integration gate

Approvals control individual tool calls; the lane check refuses patches that collide.
Neither knows what a project means by verified, so a lane could be handed over because its
patch applied cleanly while the tests had never run. A workspace closes that with the one
rule this release enforces:

```json
"integration": { "requires": ["typecheck", "test"], "allowOverride": false }
```

**Evidence is matched on the tree, not on the lane.** Running a check records evidence
carrying the working-tree hash it ran against. At integration the lane is hashed again and
each requirement is `satisfied`, `missing`, `failed` or `stale` — where stale means it
passed against content that is not this content. That is the failure an instruction in a
prompt cannot catch, and it is why evidence is bound to a tree at all. Two lanes with
identical content are identical content, so evidence from either satisfies both.

**The core decides, before anything is applied.** The same `gate(agent)` call answers the
panel and gates the integration, so the UI cannot show one verdict while the core acts on
another, and a refusal happens before `git apply` is reached — the user's directory is
untouched, not rolled back.

**Names, not commands.** A requirement names a `verify` entry, and the declaration is
rejected at validation time if no such entry exists: a requirement that can never be
satisfied should fail when the file is written, not when someone is trying to hand over
work.

**The verdict is appended either way.** `gate.evaluated` records what was decided, the
candidate it was decided about, every requirement's state, and the override if there was
one. A gate that only leaves a trace when it says no cannot be audited for the times it
said yes.

**No bypass unless a project asks for one.** `allowOverride` defaults to false and an
override is refused outright where it is not set. Where it is, the reason is required and
goes into the record beside the requirements it went around.

This is deliberately a rule, not a rule *engine*: one gate, four states, no policy
language. What it is meant to prove is the control-plane shape — the core evaluates, the
log records, the UI reports — before anything more general is built on it.

---

## 12. What v1 deliberately does not do

- **Diff parity via working-tree snapshots.** Codex reports a cumulative turn diff via
  `turn/diff/updated`. Claude has no equivalent in the stream-json protocol: its
  `Edit`/`Write` results are prose confirmations, not patches. Rather than reconstruct a
  diff by parsing that prose — which would be wrong in ways the user cannot detect — the
  orchestrator captures the working tree with a throwaway-index git snapshot before and
  after any turn whose agent lacks a native diff (`capabilities.turnDiff === false`), and
  emits the delta as the same `diff.updated` event Codex produces (`util/git.ts`). Ground
  truth from the filesystem, never an interpretation of tool output. It is a no-op outside
  a git repository, and Codex is never shadowed since it reports its own.
- **No multi-agent parallelism in one shared directory.** Two agents writing to the same
  working directory at the same time is a correctness problem, not a feature. Parallelism
  is offered only where it is safe — one worktree per agent, see §7 — and never by
  loosening the rule in the shared-directory mode.
- **No summarization.** By your decision — full replay, and when the budget cannot hold it,
  the brief tier from §4. Both tiers are deterministic renderings of logged events; no
  model reads the transcript to compress it, so a replay never contains a claim no agent
  made.
- **No auth management.** Both CLIs use their own existing logins. The harness never sees
  a token.
