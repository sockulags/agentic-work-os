import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  AGENT_IDS,
  WORKSPACE_LEGACY_INTEGRATION_GUARDRAIL_ID,
  WORKSPACE_FILE,
  WORKSPACE_LOCAL_FILE,
  WORKSPACE_SCHEMA_VERSION,
} from '@awos/protocol';
import type {
  AgentId,
  EffectiveWorkspace,
  WorkspaceGuardrail,
  WorkspaceField,
  WorkspaceOrigin,
  WorkspaceProblem,
  WorkspaceResolution,
} from '@awos/protocol';
import { parseDeclaration, type WorkspaceDeclaration } from './declaration.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('workspace');

/**
 * Turning a directory into the settings a project owns.
 *
 * Resolution is keyed on a path, never on a thread. A workspace is a property of the
 * repository — two threads in the same checkout see the same one, a thread that has never
 * run resolves the same as one with a thousand turns, and no stored thread has to carry a
 * copy that could go stale. That is also why nothing here is cached: the files are small,
 * the calls are rare, and re-reading is what lets an edit made in an editor take effect on
 * the next turn instead of the next restart.
 *
 * Precedence runs defaults → shared declaration → local override → environment, with one
 * deliberate exception noted at `applyEnvironment`.
 */

export interface ResolveOptions {
  /**
   * `AWOS_LANE_SETUP`, kept as a fallback for directories that declare no workspace.
   *
   * It predates the contract and is how lanes work today; a checkout that has not been
   * declared should not lose the setup command it already had.
   */
  laneSetup?: string;
  /** Concrete pinned expectation ids; absent means expectation guardrails fail closed. */
  expectationItemIds?: readonly string[];
  /** Registered independent evaluator capability ids; absent means model guardrails fail closed. */
  evaluatorProfileIds?: readonly string[];
}

export function resolveWorkspace(cwd: string, options: ResolveOptions = {}): WorkspaceResolution {
  const from = resolvePath(cwd);
  const root = findWorkspaceRoot(from);
  if (root === null) return { status: 'none', searchedFrom: from };

  const problems: WorkspaceProblem[] = [];
  const shared = readLayer(root, WORKSPACE_FILE, true, problems, options);
  const local = readLayer(root, WORKSPACE_LOCAL_FILE, false, problems, options);

  if (
    shared?.declaration.version === WORKSPACE_SCHEMA_VERSION &&
    local?.declaration.version !== WORKSPACE_SCHEMA_VERSION &&
    local?.declaration.integration !== undefined
  ) {
    problems.push({
      severity: 'error',
      file: WORKSPACE_LOCAL_FILE,
      path: 'integration',
      message: 'A local legacy integration declaration cannot override schema-v3 guardrail policy.',
    });
  }
  validateSharedV3VerificationPolicy(shared, local, problems);

  if (problems.some((problem) => problem.severity === 'error')) {
    return { status: 'invalid', root, problems };
  }
  // Only reachable if the file vanished between the existence check and the read, which is
  // a race worth reporting rather than crashing on.
  if (shared === null) {
    return {
      status: 'invalid',
      root,
      problems: [
        { severity: 'error', file: WORKSPACE_FILE, path: '', message: 'The declaration could not be read.' },
      ],
    };
  }

  const workspace = merge(root, shared, local, options);
  problems.push(...checkPaths(root, workspace));
  return { status: 'ok', workspace, problems };
}

/**
 * The nearest ancestor of `from` that declares a workspace, or null.
 *
 * Nearest wins so that a repository inside another one — a vendored checkout, a worktree
 * parked under a parent project — answers for itself rather than inheriting rules written
 * for something else.
 */
export function findWorkspaceRoot(from: string): string | null {
  let dir = resolvePath(from);
  for (;;) {
    if (existsSync(join(dir, WORKSPACE_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------

interface Layer {
  declaration: WorkspaceDeclaration;
  file: string;
}

function readLayer(
  root: string,
  file: string,
  standalone: boolean,
  problems: WorkspaceProblem[],
  options: ResolveOptions,
): Layer | null {
  const path = join(root, file);
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    // A file that is there but unreadable is a different fact from one that is absent, and
    // silently treating it as absent would hand the user settings they did not choose.
    problems.push({
      severity: 'error',
      file,
      path: '',
      message: `Could not be read: ${(err as Error).message}`,
    });
    return null;
  }

  const parsed = parseDeclaration(raw, {
    file,
    standalone,
    ...(options.expectationItemIds === undefined ? {} : { expectationItemIds: options.expectationItemIds }),
    ...(options.evaluatorProfileIds === undefined ? {} : { evaluatorProfileIds: options.evaluatorProfileIds }),
  });
  problems.push(...parsed.problems);
  return parsed.declaration === null ? null : { declaration: parsed.declaration, file };
}

/**
 * A local verify field may customize unrelated checks, but it cannot change a command that
 * a shared v3 verification guardrail selected. This check runs before merge so the local
 * declaration never becomes an effective weakened policy.
 */
function validateSharedV3VerificationPolicy(
  shared: Layer | null,
  local: Layer | null,
  problems: WorkspaceProblem[],
): void {
  if (shared?.declaration.version !== WORKSPACE_SCHEMA_VERSION || local?.declaration.verify === undefined) return;

  const sharedCommands = new Map<string, string>();
  for (const guardrail of shared.declaration.guardrails ?? []) {
    if (guardrail.kind !== 'verification' || !('checks' in guardrail.parameters)) continue;
    for (const check of guardrail.parameters.checks) {
      const command = shared.declaration.verify?.find((entry) => entry.name === check)?.command;
      if (command !== undefined) sharedCommands.set(check, command);
    }
  }
  for (const check of shared.declaration.integration?.requires ?? []) {
    const command = shared.declaration.verify?.find((entry) => entry.name === check)?.command;
    if (command !== undefined) sharedCommands.set(check, command);
  }

  for (const [name, command] of sharedCommands) {
    const localIndex = local.declaration.verify.findIndex((entry) => entry.name === name);
    const localEntry = local.declaration.verify[localIndex];
    if (localEntry === undefined) {
      problems.push({
        severity: 'error',
        file: WORKSPACE_LOCAL_FILE,
        path: 'verify',
        message: `Local verification cannot remove shared check "${name}" selected by a schema-v3 guardrail. Keep it with command "${command}".`,
      });
      continue;
    }
    if (localEntry.command !== command) {
      problems.push({
        severity: 'error',
        file: WORKSPACE_LOCAL_FILE,
        path: `verify[${localIndex}].command`,
        message: `Local verification cannot change shared check "${name}" selected by a schema-v3 guardrail. Keep command "${command}".`,
      });
    }
  }
}

function merge(
  root: string,
  shared: Layer,
  local: Layer | null,
  options: ResolveOptions,
): EffectiveWorkspace {
  const origins: Record<WorkspaceField, WorkspaceOrigin> = {
    name: 'default',
    repository: 'default',
    agents: 'default',
    setup: 'default',
    verify: 'default',
    integration: 'default',
    context: 'default',
    roles: 'default',
    steps: 'default',
    routes: 'default',
    guardrails: 'default',
  };

  const workspace: EffectiveWorkspace = {
    root,
    name: '',
    repository: { root: '.', github: null },
    agents: [...AGENT_IDS] as AgentId[],
    setup: { command: '', timeoutMs: null },
    verify: [],
    // Nothing required and no override: a project that has said nothing has not asked for
    // a gate, and has certainly not asked for a way around one.
    integration: { requires: [], allowOverride: false },
    context: { references: [], notes: '' },
    roles: [],
    steps: [],
    routes: [],
    guardrails: [],
    origins,
    sources: [shared.file],
  };
  if (local) workspace.sources.push(local.file);

  // Whole fields replace rather than deep-merge. An override that half-applies is a rule
  // nobody can hold in their head: `agents: ["claude"]` locally means exactly that, not
  // "claude plus whatever the shared file also listed".
  for (const layer of [shared, local]) {
    if (!layer) continue;
    const origin: WorkspaceOrigin = layer === shared ? 'shared' : 'local';
    const d = layer.declaration;

    if (d.name !== undefined) {
      workspace.name = d.name;
      origins.name = origin;
    }
    if (d.repository !== undefined) {
      workspace.repository = {
        root: d.repository.root ?? '.',
        github: d.repository.github ?? null,
      };
      origins.repository = origin;
    }
    if (d.agents !== undefined) {
      workspace.agents = d.agents;
      origins.agents = origin;
    }
    if (d.setup !== undefined) {
      workspace.setup = { command: d.setup.command, timeoutMs: d.setup.timeoutMs ?? null };
      origins.setup = origin;
    }
    if (d.verify !== undefined) {
      workspace.verify = d.verify;
      origins.verify = origin;
    }
    if (d.integration !== undefined) {
      workspace.integration = {
        requires: d.integration.requires ?? [],
        allowOverride: d.integration.allowOverride ?? false,
      };
      origins.integration = origin;
    }
    if (d.context !== undefined) {
      workspace.context = {
        references: d.context.references ?? [],
        notes: d.context.notes ?? '',
      };
      origins.context = origin;
    }
    // Routing is owned by the shared declaration. The parser rejects these fields in a
    // local override, so keeping this in the same whole-field precedence loop preserves
    // provenance without allowing machine-local routing to replace project policy.
    if (origin === 'shared' && d.roles !== undefined) {
      workspace.roles = d.roles;
      origins.roles = origin;
    }
    if (origin === 'shared' && d.steps !== undefined) {
      workspace.steps = d.steps;
      origins.steps = origin;
    }
    if (origin === 'shared' && d.routes !== undefined) {
      workspace.routes = d.routes;
      origins.routes = origin;
    }
    if (origin === 'shared' && d.guardrails !== undefined) {
      workspace.guardrails = d.guardrails.map(normalizeGuardrail);
      origins.guardrails = origin;
    }
  }

  normalizeLegacyIntegration(workspace);
  applyEnvironment(workspace, options);
  return workspace;
}

/** Keep the pre-v3 integration contract visible as one reserved verification guardrail. */
function normalizeLegacyIntegration(workspace: EffectiveWorkspace): void {
  if (workspace.integration.requires.length === 0) return;

  workspace.guardrails.push({
    id: WORKSPACE_LEGACY_INTEGRATION_GUARDRAIL_ID,
    kind: 'verification',
    attach: { from: 'lane', to: 'workspace' },
    enforcement: 'required',
    allowOverride: workspace.integration.allowOverride,
    parameters: { checks: [...workspace.integration.requires] },
    correction: { maxRuns: 2, onExhausted: 'waiting-for-human' },
  });
  workspace.origins.guardrails = workspace.origins.integration;
}

function normalizeGuardrail(input: NonNullable<WorkspaceDeclaration['guardrails']>[number]): WorkspaceGuardrail {
  return {
    id: input.id,
    kind: input.kind,
    attach: input.attach,
    enforcement: input.enforcement,
    allowOverride: input.allowOverride ?? false,
    parameters: input.parameters,
    correction: {
      maxRuns: input.correction?.maxRuns ?? 2,
      onExhausted: input.correction?.onExhausted ?? 'waiting-for-human',
    },
  };
}

/**
 * The environment fills gaps; it does not overrule the project.
 *
 * The opposite of how `HarnessConfig` treats env, and deliberately so. Those settings
 * describe the machine — where the binaries are, which port to bind — and the machine is
 * the authority on them. This one describes the project, and a repository that states how
 * it is installed should not be broken by a stale `AWOS_LANE_SETUP` left in someone's
 * shell. So the variable is consulted only where the declaration is silent.
 */
function applyEnvironment(workspace: EffectiveWorkspace, options: ResolveOptions): void {
  const laneSetup = options.laneSetup?.trim() ?? '';
  if (workspace.setup.command === '' && laneSetup !== '') {
    workspace.setup = { command: laneSetup, timeoutMs: null };
    workspace.origins.setup = 'environment';
  }
}

/**
 * Values that parsed but do not point at anything.
 *
 * Warnings, not errors: a moved reference file is worth saying out loud, and is not a
 * reason to refuse to open the project. They are what the UI means by "unresolved".
 */
function checkPaths(root: string, workspace: EffectiveWorkspace): WorkspaceProblem[] {
  const problems: WorkspaceProblem[] = [];
  const file = workspace.origins.repository === 'local' ? WORKSPACE_LOCAL_FILE : WORKSPACE_FILE;

  if (!existsSync(join(root, workspace.repository.root))) {
    problems.push({
      severity: 'warning',
      file,
      path: 'repository.root',
      message: `No directory at "${workspace.repository.root}" inside the workspace.`,
    });
  }

  const contextFile = workspace.origins.context === 'local' ? WORKSPACE_LOCAL_FILE : WORKSPACE_FILE;
  workspace.context.references.forEach((reference, index) => {
    if (existsSync(join(root, reference))) return;
    problems.push({
      severity: 'warning',
      file: contextFile,
      path: `context.references[${index}]`,
      message: `No file at "${reference}" inside the workspace.`,
    });
  });

  if (problems.length > 0) log.debug('workspace has unresolved paths', { root, count: problems.length });
  return problems;
}
