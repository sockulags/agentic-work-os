import type { ExpectationItemKind } from '@awos/protocol';
import { CORE_EVALUATOR_KINDS, type CoreEvaluatorKind } from '../work/evaluators.js';

/**
 * The resolver's only expectation registry. These are core-owned, stable identities from
 * the schema-v3 contract; a workspace may select them, but cannot add a runtime evaluator or
 * redefine what an identity means through the resolver call.
 */
export interface CoreExpectationManifestEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: ExpectationItemKind;
}

const entries = [
  { id: 'evidence.plan', name: 'Evidence plan', kind: 'plan' },
  { id: 'question.scope', name: 'Scope answer', kind: 'mandatory-question' },
  { id: 'review.semantic', name: 'Semantic review', kind: 'human-attestation' },
  { id: 'prototype.dashboard', name: 'Dashboard prototype', kind: 'prototype' },
  { id: 'scope', name: 'Scope', kind: 'constraint' },
] as const satisfies readonly CoreExpectationManifestEntry[];

export const CORE_EXPECTATION_MANIFEST: readonly CoreExpectationManifestEntry[] = Object.freeze(
  entries.map((entry) => Object.freeze(entry)),
);

export const CORE_EXPECTATION_ITEM_IDS: readonly string[] = Object.freeze(
  CORE_EXPECTATION_MANIFEST.map((entry) => entry.id),
);

/** Core owns the closed evaluator kinds but registers no model provider or runtime capability. */
export const CORE_RESOLVER_EVALUATOR_KINDS: readonly CoreEvaluatorKind[] = CORE_EVALUATOR_KINDS;
export const CORE_EVALUATOR_PROFILE_IDS: readonly string[] = Object.freeze([]);

export function coreExpectationManifestEntry(id: string): CoreExpectationManifestEntry | null {
  return CORE_EXPECTATION_MANIFEST.find((entry) => entry.id === id) ?? null;
}
