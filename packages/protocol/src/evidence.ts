/**
 * What a run produced, what supports that claim, and what is worth keeping.
 *
 * A `turn.completed` with reason `completed` means an agent stopped without a protocol
 * error. It does not mean the work is right, and nothing in the log distinguishes the two.
 * These three records close that gap without pretending to judge anything:
 *
 *   - an **outcome**, stated by whoever is in a position to state it;
 *   - **evidence**, pointing at facts already in the log, or at something outside it;
 *   - **retained context** — what was learned, decided, ruled out or left open.
 *
 * None of it is scored, ranked or inferred. A passing test is a passing test; whether it
 * shows the work was done is a claim a person or an agent makes, attributed to them.
 *
 * All three are append-only. A correction is a new record carrying the same id, and the
 * fold takes the last one — so the current answer is cheap to read and every earlier claim
 * is still in the log, in order, with its author and its time.
 */

import type { AgentId } from './events.js';

/** What a run claims to have achieved. Distinct from how the turn ended. */
export type RunClaim = 'delivered' | 'partial' | 'blocked' | 'abandoned';

/** Where an evidence item points. */
export type EvidenceKind = 'command' | 'diff' | 'artifact' | 'approval' | 'link' | 'note';

export type RetainedKind = 'discovery' | 'decision' | 'constraint' | 'question';

/** Who made a claim. `user` is the person at the keyboard; the rest are the agents. */
export type ClaimSource = 'user' | AgentId;

/**
 * What the evidence points at.
 *
 * `eventId` refers to a fact already in this thread's log — a command that ran, a diff, an
 * artifact, an approval — which is what keeps evidence from being a retelling. `url` is
 * for the things that are true outside the harness, and a person has to supply those.
 */
export interface EvidenceRef {
  eventId: string | null;
  url: string | null;
  /** What to show when the referenced fact is not on screen. */
  label: string;
}

/**
 * The code the evidence is about.
 *
 * Both halves matter: `commit` says which revision, `tree` is the hash of the working tree
 * as it actually stood, including anything uncommitted. `dirty` is the comparison already
 * made, because "the tests passed" means something different when the tree did not match
 * any commit. All null outside a git repository, where none of this can be established.
 */
export interface WorkingState {
  commit: string | null;
  tree: string | null;
  dirty: boolean;
}

/**
 * The result of a check the project named.
 *
 * Present only on evidence produced by running one, which is what lets a gate tell "this
 * is the `test` check, and it passed" from "somebody attached a command that mentions
 * tests". Everything else — what ran, against which tree — is on the evidence itself.
 */
export interface CheckResult {
  /** A `verify` entry's name. */
  name: string;
  passed: boolean;
  exitCode: number | null;
}

export interface EvidenceItem {
  id: string;
  /** The run it came out of, or null for a check run outside one. */
  runId: string | null;
  /** The work item it is about, or null when the thread has none. */
  workItemId: string | null;
  threadId: string;
  kind: EvidenceKind;
  ref: EvidenceRef;
  summary: string;
  state: WorkingState;
  check: CheckResult | null;
  source: ClaimSource;
  at: number;
}

export interface RetainedItem {
  id: string;
  workItemId: string;
  kind: RetainedKind;
  text: string;
  /** The run it came out of, or null when it was written down outside one. */
  runId: string | null;
  threadId: string;
  source: ClaimSource;
  at: number;
  /** Whether later runs on this work item are given it. */
  selected: boolean;
  /** Kept, but no longer true or no longer useful. Never deleted. */
  retired: boolean;
}

export interface RunOutcome {
  runId: string;
  claim: RunClaim;
  statement: string;
  source: ClaimSource;
  at: number;
}

/**
 * Why an integration was allowed or refused, requirement by requirement.
 *
 * `missing` — nothing has run it. `failed` — the last result for it was a failure.
 * `stale` — it passed, but against a tree that is not the one being integrated, which is
 * the case text instructions cannot catch and the reason evidence is bound to a tree at
 * all. `satisfied` — it passed against exactly this candidate.
 */
export type RequirementState = 'satisfied' | 'missing' | 'failed' | 'stale';

export interface RequirementResult {
  name: string;
  command: string;
  state: RequirementState;
  /** The evidence that decided it, when there was any. */
  evidenceId: string | null;
  /** The tree that evidence was recorded against, for comparison with the candidate. */
  evidenceTree: string | null;
}

/** A recorded decision to integrate anyway, where the project permits one. */
export interface GateOverride {
  actor: ClaimSource;
  reason: string;
}

/** How much retained context a run's prompt will carry. */
export const RETAINED_CONTEXT_MAX_CHARS = 4_000;

/**
 * Where an agent writes what it wants kept, relative to its working directory.
 *
 * A file, for the same reason artifacts are a file: it is the one publishing mechanism
 * both CLIs already have, needs nothing registered with either of them, and leaves a real
 * artifact on disk. One JSON object per line, `{"kind":"decision","text":"…"}`.
 */
export const RETAINED_FILE = '.awos/retained.jsonl';
