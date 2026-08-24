/**
 * The project workspace contract: what a repository declares about itself.
 *
 * A thread knows a working directory; a workspace knows a project. The difference is
 * ownership — `HarnessConfig` holds the settings of the machine the harness runs on, and
 * this holds the settings the project itself owns and reviews in Git. Which agents are
 * allowed, what makes a fresh checkout usable, what "verified" means here: none of that
 * is a property of an install, and none of it should have to be rediscovered per thread.
 *
 * The declaration lives at `<root>/.awos/workspace.json`, committed. Machine-specific
 * values that would be wrong in someone else's checkout go in `<root>/.awos/local/
 * workspace.json`, which stays out of Git. Nothing here is ever a secret: the schema is
 * closed, so there is no field to put one in.
 *
 * Types only. Reading, validating and merging the files is `@awos/core`'s job — this is
 * the shape both ends agree on.
 */

import type { EvidenceKind, Enforcement, PixelCaptureContract } from './evidence.js';
import type { AgentId, WorkerProfileId } from './events.js';

/**
 * The version this build understands.
 *
 * A declaration states its own version and an unknown one is refused rather than
 * best-effort parsed: a file written for a later schema will differ in ways that read as
 * valid to an older validator, and silently running with half a contract is worse than
 * saying which build you need.
 */
export const WORKSPACE_SCHEMA_VERSION = 3;

/** Path of the shared declaration, relative to the workspace root. */
export const WORKSPACE_FILE = '.awos/workspace.json';

/** Path of the local override, relative to the workspace root. Never committed. */
export const WORKSPACE_LOCAL_FILE = '.awos/local/workspace.json';

/** Stable identity used when legacy integration checks are projected into v3. */
export const WORKSPACE_LEGACY_INTEGRATION_GUARDRAIL_ID = 'workspace-integration';

/** How much of `context.notes` a turn's prompt will carry. */
export const WORKSPACE_NOTES_MAX_CHARS = 2_000;

/** A named command a later gate can ask for by name. Nothing runs it yet. */
export interface VerifyCommand {
  name: string;
  command: string;
}

/** What has to happen in a fresh checkout — a lane, mostly — before work can run. */
export interface WorkspaceSetup {
  /** Shell command, or empty when the project declares none. */
  command: string;
  /** How long it may run, or null to use the harness default. */
  timeoutMs: number | null;
}

export interface WorkspaceRepository {
  /** The primary repository, relative to the workspace root. Usually `.`. */
  root: string;
  /** `owner/name` on GitHub, or null when the project does not say. */
  github: string | null;
}

/**
 * What has to be true before a lane's work may be applied to the user's directory.
 *
 * Names of `verify` entries, not commands: the project says *what* must have passed, and
 * the command behind that name stays in one place. An empty list is the default and means
 * what it always meant — integration is gated on the patch applying, and nothing else.
 *
 * `allowOverride` is off unless a project turns it on. A bypass that exists by default is
 * one nobody decided to have; a project that wants an escape hatch has to say so, in the
 * file, where the decision is reviewable.
 */
export interface WorkspaceIntegration {
  requires: string[];
  allowOverride: boolean;
}

export interface WorkspaceContext {
  /** Files worth reading before working here, relative to the workspace root. */
  references: string[];
  /** Standing project notes carried into every turn. */
  notes: string;
}

/** A named role in the shared workspace routing contract. */
export interface WorkspaceRole {
  id: string;
  label: string;
}

/** A routing step that assigns work to a role and its allowed worker profiles. */
export interface WorkspaceStep {
  id: string;
  action: string;
  role: string;
  workers: WorkerProfileId[];
}

/** Label predicates supported by a workspace route. */
export interface WorkspaceRouteMatch {
  allLabels?: string[];
  anyLabels?: string[];
  noneLabels?: string[];
}

/** A declaration-order route from issue labels to a routing step. */
export interface WorkspaceRoute {
  id: string;
  match: WorkspaceRouteMatch;
  step: string;
}

/** The closed set of guardrails a workspace may select. */
export type WorkspaceGuardrailKind =
  | 'verification'
  | 'evidence-present'
  | 'mandatory-answer'
  | 'human-attestation'
  | 'pixel-diff'
  | 'model-rubric';

/** Where a guardrail applies without creating a workflow edge. */
export type WorkspaceGuardrailAttachment =
  | { step: string }
  | { from: string; to: string };

export type WorkspaceGuardrailExhaustedAction = 'waiting-for-human' | 'blocked';

/** The bounded correction setting carried by an effective guardrail. */
export interface WorkspaceGuardrailCorrection {
  maxRuns: number;
  onExhausted: WorkspaceGuardrailExhaustedAction;
}

/** Workspace declarations reuse the bounded, runtime-neutral capture contract. */
export type WorkspacePixelCaptureContract = PixelCaptureContract;

export interface WorkspaceVerificationParameters {
  checks: string[];
}

export interface WorkspaceExpectationParameters {
  expectationItem: string;
}

export interface WorkspaceEvidencePresentParameters extends WorkspaceExpectationParameters {
  /** Optional evidence type selector; the expectation item remains the pinned identity. */
  evidenceKind?: EvidenceKind;
}

export interface WorkspaceMandatoryAnswerParameters extends WorkspaceExpectationParameters {
  authority?: 'user';
}

export interface WorkspaceHumanAttestationParameters extends WorkspaceExpectationParameters {
  authority: 'user';
}

export interface WorkspacePixelDiffParameters extends WorkspaceExpectationParameters {
  capture?: WorkspacePixelCaptureContract;
  /** Exact pixel comparison may be selected, but absolute enforcement requires it explicitly. */
  exact?: boolean;
}

export interface WorkspaceModelRubricParameters extends WorkspaceExpectationParameters {
  /** A stable registered evaluator capability, never a worker/provider/model selector. */
  evaluatorProfile: string;
}

/** Closed, typed parameters for one built-in guardrail kind. */
export type WorkspaceGuardrailParameters =
  | WorkspaceVerificationParameters
  | WorkspaceExpectationParameters
  | WorkspaceEvidencePresentParameters
  | WorkspaceMandatoryAnswerParameters
  | WorkspaceHumanAttestationParameters
  | WorkspacePixelDiffParameters
  | WorkspaceModelRubricParameters;

/** A normalized guardrail exposed by workspace resolution. */
export interface WorkspaceGuardrail {
  id: string;
  kind: WorkspaceGuardrailKind;
  attach: WorkspaceGuardrailAttachment;
  enforcement: Enforcement;
  allowOverride: boolean;
  parameters: WorkspaceGuardrailParameters;
  correction: WorkspaceGuardrailCorrection;
}

/** Declaration form; omitted policy fields receive safe defaults during parsing/resolution. */
export interface WorkspaceGuardrailConfig {
  id: string;
  kind: WorkspaceGuardrailKind;
  attach: WorkspaceGuardrailAttachment;
  enforcement: Enforcement;
  allowOverride?: boolean;
  parameters: WorkspaceGuardrailParameters;
  correction?: { maxRuns?: number; onExhausted?: WorkspaceGuardrailExhaustedAction };
}

/**
 * Something wrong with a declaration, addressed to whoever has to fix it.
 *
 * Errors mean the workspace does not resolve. Warnings mean it resolved but something in
 * it does not point at anything — a reference file that was moved, a repository root that
 * is not there — which is worth showing without refusing to open the project over it.
 */
export interface WorkspaceProblem {
  severity: 'error' | 'warning';
  /** Which file it is in, relative to the workspace root. */
  file: string;
  /** Dotted path within that file, or empty when it is about the file as a whole. */
  path: string;
  message: string;
}

/**
 * Which layer supplied a value.
 *
 * Shown in the UI because "where did this come from" is the first question anyone asks of
 * an effective setting that surprised them.
 */
export type WorkspaceOrigin = 'shared' | 'local' | 'environment' | 'default';

export type WorkspaceField =
  | 'name'
  | 'repository'
  | 'agents'
  | 'setup'
  | 'verify'
  | 'integration'
  | 'context'
  | 'roles'
  | 'steps'
  | 'routes'
  | 'guardrails';

/** A declaration resolved through every layer, with the provenance of each field. */
export interface EffectiveWorkspace {
  /** Absolute path of the directory that holds `.awos/`. */
  root: string;
  name: string;
  repository: WorkspaceRepository;
  /** Adapters this project allows. A turn to any other agent is refused. */
  agents: AgentId[];
  setup: WorkspaceSetup;
  verify: VerifyCommand[];
  integration: WorkspaceIntegration;
  context: WorkspaceContext;
  roles: WorkspaceRole[];
  steps: WorkspaceStep[];
  routes: WorkspaceRoute[];
  guardrails: WorkspaceGuardrail[];
  origins: Record<WorkspaceField, WorkspaceOrigin>;
  /** Files that contributed, in the order they were applied. */
  sources: string[];
}

/**
 * What resolving a directory produced.
 *
 * `none` is not a failure: a directory that has never been declared a workspace is the
 * normal state of most of them, and the harness works there exactly as it did before.
 */
export type WorkspaceResolution =
  | { status: 'none'; searchedFrom: string }
  | { status: 'invalid'; root: string; problems: WorkspaceProblem[] }
  | { status: 'ok'; workspace: EffectiveWorkspace; problems: WorkspaceProblem[] };
