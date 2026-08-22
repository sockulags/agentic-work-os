import type {
  EvidenceItem,
  RequirementResult,
  VerifyCommand,
  WorkspaceIntegration,
} from '@awos/protocol';

/**
 * The one enforceable rule: what must have passed against exactly this content before a
 * lane's work reaches the user's directory.
 *
 * Deterministic and local. There is no policy language here and no judgement about
 * whether the configured command proves anything — the project names the checks, the
 * harness asks whether each one passed against the tree being integrated, and that is the
 * entire semantics.
 *
 * Evidence is matched on the **tree hash**, not on which lane it came from. Two lanes with
 * identical content are identical content; a check that passed against that content
 * passed against it wherever it ran. And a tree that has moved since is precisely the case
 * an instruction in a prompt cannot catch: the tests really did pass, just not on this.
 */

export interface GateInput {
  integration: WorkspaceIntegration;
  /** The project's named commands, for reporting what a requirement actually runs. */
  verify: readonly VerifyCommand[];
  /** Every evidence item this thread has recorded. */
  evidence: readonly EvidenceItem[];
  /** The tree being integrated, or null when it could not be established. */
  candidateTree: string | null;
}

export interface GateDecision {
  allowed: boolean;
  requirements: RequirementResult[];
}

export function evaluateGate(input: GateInput): GateDecision {
  const requirements = input.integration.requires.map((name) =>
    evaluateOne(name, input),
  );
  return {
    allowed: requirements.every((requirement) => requirement.state === 'satisfied'),
    requirements,
  };
}

function evaluateOne(name: string, input: GateInput): RequirementResult {
  const command = input.verify.find((entry) => entry.name === name)?.command ?? '';
  const base = { name, command };

  // The most recent result for this check decides it. An earlier failure that was fixed
  // is history, not a veto; an earlier pass that was later broken must not be one either.
  const latest = [...input.evidence]
    .filter((item) => item.check?.name === name)
    .sort((a, b) => a.at - b.at)
    .pop();

  if (latest === undefined) {
    return { ...base, state: 'missing', evidenceId: null, evidenceTree: null };
  }

  const evidenceTree = latest.state.tree;
  if (latest.check?.passed !== true) {
    return { ...base, state: 'failed', evidenceId: latest.id, evidenceTree };
  }

  // No candidate tree means the working copy is not a git repository, so nothing can be
  // shown to be about this content. Refusing beats claiming a match nobody established.
  if (input.candidateTree === null || evidenceTree === null || evidenceTree !== input.candidateTree) {
    return { ...base, state: 'stale', evidenceId: latest.id, evidenceTree };
  }

  return { ...base, state: 'satisfied', evidenceId: latest.id, evidenceTree };
}

/** One line a person can act on, naming what is unsatisfied and why. */
export function explainGate(decision: GateDecision): string {
  const unsatisfied = decision.requirements.filter((entry) => entry.state !== 'satisfied');
  if (unsatisfied.length === 0) return 'every required check passed against this candidate';

  return unsatisfied
    .map((entry) => {
      switch (entry.state) {
        case 'missing':
          return `${entry.name} has not been run`;
        case 'failed':
          return `${entry.name} failed`;
        default:
          return `${entry.name} passed against different content`;
      }
    })
    .join('; ');
}
