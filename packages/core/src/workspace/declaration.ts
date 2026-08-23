import { AGENT_IDS, WORKSPACE_SCHEMA_VERSION } from '@awos/protocol';
import type {
  AgentId,
  VerifyCommand,
  WorkspaceProblem,
  WorkspaceRole,
  WorkspaceRoute,
  WorkspaceStep,
} from '@awos/protocol';

/**
 * Reading and checking one workspace file.
 *
 * Hand-written rather than delegated to a schema library, for the same reason
 * `packages/protocol` has no runtime dependencies: this is thirty fields, and the thing
 * that actually matters about the checking is the wording of the failures. A generic
 * validator's "expected string, received number at /verify/1/command" is a message about
 * the schema; someone editing a config file needs a message about their project.
 *
 * Every problem is collected rather than thrown on the first one. A file with three
 * mistakes in it should cost one round of editing, not three.
 */

/** The file's shape. Every field but `version` is optional; the resolver fills the rest. */
export interface WorkspaceDeclaration {
  version: number;
  name?: string;
  repository?: { root?: string; github?: string | null };
  agents?: AgentId[];
  setup?: { command: string; timeoutMs?: number };
  verify?: VerifyCommand[];
  integration?: { requires?: string[]; allowOverride?: boolean };
  context?: { references?: string[]; notes?: string };
  roles?: WorkspaceRole[];
  steps?: WorkspaceStep[];
  routes?: WorkspaceRoute[];
}

export interface ParsedDeclaration {
  /** Null when the file has errors. Warnings alone still produce a declaration. */
  declaration: WorkspaceDeclaration | null;
  problems: WorkspaceProblem[];
}

export interface ParseOptions {
  /** Path shown in problems, relative to the workspace root. */
  file: string;
  /**
   * Whether this file has to stand on its own.
   *
   * The shared declaration does: it is what makes the directory a workspace, so it must
   * name itself. The local override does not — it exists to change two fields on a
   * machine where the shared answer is wrong, and requiring it to restate the project's
   * identity would just be a second place for that identity to drift.
   */
  standalone: boolean;
}

const TOP_LEVEL_KEYS = [
  'version',
  'name',
  'repository',
  'agents',
  'setup',
  'verify',
  'integration',
  'context',
  'roles',
  'steps',
  'routes',
] as const;

const MAX_NAME_CHARS = 80;
const MAX_REFERENCES = 20;

/** Lowercase and hyphenated, because later gates will name these on a command line. */
const STABLE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const VERIFY_NAME_RE = STABLE_ID_RE;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SUPPORTED_SCHEMA_VERSIONS = [1, WORKSPACE_SCHEMA_VERSION] as const;

export function parseDeclaration(raw: string, options: ParseOptions): ParsedDeclaration {
  const problems: WorkspaceProblem[] = [];
  const fail = (path: string, message: string): void => {
    problems.push({ severity: 'error', file: options.file, path, message });
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail('', `Not valid JSON: ${(err as Error).message}`);
    return { declaration: null, problems };
  }

  if (!isRecord(parsed)) {
    fail('', 'The file must contain a JSON object.');
    return { declaration: null, problems };
  }

  for (const key of Object.keys(parsed)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      fail(
        key,
        `Unknown setting "${key}". This file understands: ${TOP_LEVEL_KEYS.join(', ')}. ` +
          'The schema is closed on purpose — nothing here is a place for credentials.',
      );
    }
  }

  const declaration: WorkspaceDeclaration = { version: WORKSPACE_SCHEMA_VERSION };

  // Version first and hardest: everything below only means what it means under a schema
  // this build actually knows.
  const version = parsed['version'];
  if (version === undefined) {
    fail('version', `Missing "version". This build writes and reads version ${WORKSPACE_SCHEMA_VERSION}.`);
  } else if (typeof version !== 'number' || !Number.isInteger(version)) {
    fail('version', '"version" must be a whole number.');
  } else if (!(SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(version)) {
    fail(
      'version',
      `Schema version ${version} is not supported. This build understands version ` +
        `${SUPPORTED_SCHEMA_VERSIONS.join(' and ')}; upgrade Agentic Work OS or lower the version.`,
    );
  } else {
    declaration.version = version;
  }

  const name = parsed['name'];
  if (name === undefined) {
    if (options.standalone) fail('name', 'Missing "name". A workspace has to name itself.');
  } else if (typeof name !== 'string' || name.trim() === '') {
    fail('name', '"name" must be a non-empty string.');
  } else if (name.length > MAX_NAME_CHARS) {
    fail('name', `"name" is longer than ${MAX_NAME_CHARS} characters.`);
  } else {
    declaration.name = name.trim();
  }

  const repository = parsed['repository'];
  if (repository !== undefined) {
    if (!isRecord(repository)) {
      fail('repository', '"repository" must be an object.');
    } else {
      rejectUnknown(repository, ['root', 'github'], 'repository', fail);
      const value: { root?: string; github?: string | null } = {};

      const root = repository['root'];
      if (root !== undefined) {
        const problem = relativePathProblem(root);
        if (problem) fail('repository.root', problem);
        else value.root = (root as string).trim();
      }

      const github = repository['github'];
      if (github !== undefined && github !== null) {
        if (typeof github !== 'string' || !GITHUB_REPO_RE.test(github.trim())) {
          fail('repository.github', '"repository.github" must look like "owner/name".');
        } else {
          value.github = github.trim();
        }
      }

      declaration.repository = value;
    }
  }

  const agents = parsed['agents'];
  if (agents !== undefined) {
    if (!Array.isArray(agents) || agents.length === 0) {
      fail('agents', '"agents" must be a non-empty array of agent ids.');
    } else {
      const seen = new Set<string>();
      const value: AgentId[] = [];
      agents.forEach((entry, index) => {
        if (typeof entry !== 'string' || !(AGENT_IDS as readonly string[]).includes(entry)) {
          fail(`agents[${index}]`, `Unknown agent "${String(entry)}". Known agents: ${AGENT_IDS.join(', ')}.`);
          return;
        }
        if (seen.has(entry)) {
          fail(`agents[${index}]`, `"${entry}" is listed twice.`);
          return;
        }
        seen.add(entry);
        value.push(entry as AgentId);
      });
      if (value.length > 0) declaration.agents = value;
    }
  }

  const setup = parsed['setup'];
  if (setup !== undefined) {
    if (!isRecord(setup)) {
      fail('setup', '"setup" must be an object with a "command".');
    } else {
      rejectUnknown(setup, ['command', 'timeoutMs'], 'setup', fail);
      const command = setup['command'];
      const timeoutMs = setup['timeoutMs'];

      if (typeof command !== 'string' || command.trim() === '') {
        fail('setup.command', '"setup.command" must be a non-empty shell command.');
      } else if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
        fail('setup.timeoutMs', '"setup.timeoutMs" must be a positive whole number of milliseconds.');
      } else {
        declaration.setup = { command: command.trim() };
        if (typeof timeoutMs === 'number') declaration.setup.timeoutMs = timeoutMs;
      }
    }
  }

  const verify = parsed['verify'];
  if (verify !== undefined) {
    if (!Array.isArray(verify)) {
      fail('verify', '"verify" must be an array of named commands.');
    } else {
      const seen = new Set<string>();
      const value: VerifyCommand[] = [];
      verify.forEach((entry, index) => {
        const at = `verify[${index}]`;
        if (!isRecord(entry)) {
          fail(at, 'Each verification entry must be an object with "name" and "command".');
          return;
        }
        rejectUnknown(entry, ['name', 'command'], at, fail);

        const entryName = entry['name'];
        const entryCommand = entry['command'];
        if (typeof entryName !== 'string' || !VERIFY_NAME_RE.test(entryName)) {
          fail(`${at}.name`, 'A verification name must be lowercase letters, digits and hyphens.');
          return;
        }
        if (seen.has(entryName)) {
          fail(`${at}.name`, `Two verification commands are both called "${entryName}".`);
          return;
        }
        if (typeof entryCommand !== 'string' || entryCommand.trim() === '') {
          fail(`${at}.command`, '"command" must be a non-empty shell command.');
          return;
        }
        seen.add(entryName);
        value.push({ name: entryName, command: entryCommand.trim() });
      });
      declaration.verify = value;
    }
  }

  const integration = parsed['integration'];
  if (integration !== undefined) {
    if (!isRecord(integration)) {
      fail('integration', '"integration" must be an object.');
    } else {
      rejectUnknown(integration, ['requires', 'allowOverride'], 'integration', fail);
      const value: { requires?: string[]; allowOverride?: boolean } = {};

      const requires = integration['requires'];
      if (requires !== undefined) {
        if (!Array.isArray(requires)) {
          fail('integration.requires', '"integration.requires" must be an array of verification names.');
        } else {
          const declared = new Set((declaration.verify ?? []).map((entry) => entry.name));
          const names: string[] = [];
          requires.forEach((entry, index) => {
            if (typeof entry !== 'string' || entry.trim() === '') {
              fail(`integration.requires[${index}]`, 'Each requirement is the name of a verification command.');
              return;
            }
            // Checked against this file rather than left to fail at integration time: a
            // requirement naming a command that does not exist can never be satisfied, and
            // finding that out while trying to hand over work is the worst moment for it.
            if (!declared.has(entry)) {
              fail(
                `integration.requires[${index}]`,
                `No verification command called "${entry}". Declare it under "verify" first.`,
              );
              return;
            }
            if (names.includes(entry)) {
              fail(`integration.requires[${index}]`, `"${entry}" is required twice.`);
              return;
            }
            names.push(entry);
          });
          value.requires = names;
        }
      }

      const allowOverride = integration['allowOverride'];
      if (allowOverride !== undefined) {
        if (typeof allowOverride !== 'boolean') {
          fail('integration.allowOverride', '"integration.allowOverride" must be true or false.');
        } else {
          value.allowOverride = allowOverride;
        }
      }

      declaration.integration = value;
    }
  }

  const context = parsed['context'];
  if (context !== undefined) {
    if (!isRecord(context)) {
      fail('context', '"context" must be an object.');
    } else {
      rejectUnknown(context, ['references', 'notes'], 'context', fail);
      const value: { references?: string[]; notes?: string } = {};

      const references = context['references'];
      if (references !== undefined) {
        if (!Array.isArray(references)) {
          fail('context.references', '"context.references" must be an array of file paths.');
        } else if (references.length > MAX_REFERENCES) {
          fail(
            'context.references',
            `More than ${MAX_REFERENCES} reference files. Point at the few that orient someone, ` +
              'not at the repository.',
          );
        } else {
          const paths: string[] = [];
          references.forEach((entry, index) => {
            const problem = relativePathProblem(entry);
            if (problem) fail(`context.references[${index}]`, problem);
            else paths.push((entry as string).trim());
          });
          value.references = paths;
        }
      }

      const notes = context['notes'];
      if (notes !== undefined) {
        if (typeof notes !== 'string') fail('context.notes', '"context.notes" must be a string.');
        else value.notes = notes;
      }

      declaration.context = value;
    }
  }

  parseRouting(parsed, declaration, version === WORKSPACE_SCHEMA_VERSION, options, fail);

  return {
    declaration: problems.some((problem) => problem.severity === 'error') ? null : declaration,
    problems,
  };
}

// ---------------------------------------------------------------------------

function parseRouting(
  parsed: Record<string, unknown>,
  declaration: WorkspaceDeclaration,
  version2: boolean,
  options: ParseOptions,
  fail: (path: string, message: string) => void,
): void {
  const routingKeys = ['roles', 'steps', 'routes'] as const;
  const hasRouting = routingKeys.some((key) => parsed[key] !== undefined);
  if (!hasRouting) return;

  if (!version2) {
    for (const key of routingKeys) {
      if (parsed[key] !== undefined) {
        fail(key, `"${key}" is only supported by schema version ${WORKSPACE_SCHEMA_VERSION}.`);
      }
    }
    return;
  }

  if (!options.standalone) {
    for (const key of routingKeys) {
      if (parsed[key] !== undefined) {
        fail(key, `Local overrides cannot define "${key}"; routing belongs to the shared workspace declaration.`);
      }
    }
    return;
  }

  if (parsed.roles !== undefined) {
    const roles = parseRoles(parsed.roles, fail);
    if (roles !== undefined) declaration.roles = roles;
  }

  const roleIds = new Set((declaration.roles ?? []).map((role) => role.id));
  const allowedAgents = new Set(declaration.agents ?? AGENT_IDS);
  if (parsed.steps !== undefined) {
    const steps = parseSteps(parsed.steps, roleIds, allowedAgents, fail);
    if (steps !== undefined) declaration.steps = steps;
  }

  const stepIds = new Set((declaration.steps ?? []).map((step) => step.id));
  if (parsed.routes !== undefined) {
    const routes = parseRoutes(parsed.routes, stepIds, fail);
    if (routes !== undefined) declaration.routes = routes;
  }
}

function parseRoles(
  raw: unknown,
  fail: (path: string, message: string) => void,
): WorkspaceRole[] | undefined {
  if (!Array.isArray(raw)) {
    fail('roles', '"roles" must be an array of role objects.');
    return undefined;
  }

  const seen = new Set<string>();
  const roles: WorkspaceRole[] = [];
  raw.forEach((entry, index) => {
    const at = `roles[${index}]`;
    if (!isRecord(entry)) {
      fail(at, 'Each role must be an object with "id" and "label".');
      return;
    }
    rejectUnknown(entry, ['id', 'label'], at, fail);
    const id = parseStableId(entry.id, `${at}.id`, 'role', fail);
    const duplicateId = id !== null && seen.has(id);
    if (duplicateId) fail(`${at}.id`, `Two roles are both called "${id}".`);
    else if (id !== null) seen.add(id);
    const label = parseHumanText(entry.label, `${at}.label`, 'role label', fail);
    if (id === null || label === null) return;
    if (duplicateId) return;
    roles.push({ id, label });
  });
  return roles;
}

function parseSteps(
  raw: unknown,
  roleIds: Set<string>,
  allowedAgents: Set<AgentId>,
  fail: (path: string, message: string) => void,
): WorkspaceStep[] | undefined {
  if (!Array.isArray(raw)) {
    fail('steps', '"steps" must be an array of step objects.');
    return undefined;
  }

  const seen = new Set<string>();
  const steps: WorkspaceStep[] = [];
  raw.forEach((entry, index) => {
    const at = `steps[${index}]`;
    if (!isRecord(entry)) {
      fail(at, 'Each step must be an object with "id", "action", "role" and "workers".');
      return;
    }
    rejectUnknown(entry, ['id', 'action', 'role', 'workers'], at, fail);
    const id = parseStableId(entry.id, `${at}.id`, 'step', fail);
    const duplicateId = id !== null && seen.has(id);
    if (duplicateId) fail(`${at}.id`, `Two steps are both called "${id}".`);
    else if (id !== null) seen.add(id);
    const action = parseHumanText(entry.action, `${at}.action`, 'step action', fail);
    const role = parseStableId(entry.role, `${at}.role`, 'step role', fail);
    if (role !== null && !roleIds.has(role)) {
      fail(`${at}.role`, `Unknown role "${role}". Declare it under "roles" first.`);
    }

    const workers = entry.workers;
    const workerIds: AgentId[] = [];
    const seenWorkers = new Set<AgentId>();
    if (!Array.isArray(workers) || workers.length === 0) {
      fail(`${at}.workers`, '"workers" must be a non-empty array of WorkerProfile ids.');
    } else {
      workers.forEach((worker, workerIndex) => {
        if (typeof worker !== 'string' || !(AGENT_IDS as readonly string[]).includes(worker)) {
          fail(
            `${at}.workers[${workerIndex}]`,
            `Unknown WorkerProfile "${String(worker)}". Known profiles: ${AGENT_IDS.join(', ')}.`,
          );
          return;
        }
        if (!allowedAgents.has(worker as AgentId)) {
          fail(
            `${at}.workers[${workerIndex}]`,
            `WorkerProfile "${worker}" is not allowed by this workspace's "agents" list.`,
          );
          return;
        }
        const workerId = worker as AgentId;
        if (seenWorkers.has(workerId)) {
          fail(`${at}.workers[${workerIndex}]`, `WorkerProfile "${workerId}" is listed more than once in this step.`);
          return;
        }
        seenWorkers.add(workerId);
        workerIds.push(workerId);
      });
    }

    if (id === null || action === null || role === null || !roleIds.has(role) || workerIds.length !== (Array.isArray(workers) ? workers.length : -1)) {
      return;
    }
    if (duplicateId) return;
    steps.push({ id, action, role, workers: workerIds });
  });
  return steps;
}

function parseRoutes(
  raw: unknown,
  stepIds: Set<string>,
  fail: (path: string, message: string) => void,
): WorkspaceRoute[] | undefined {
  if (!Array.isArray(raw)) {
    fail('routes', '"routes" must be an array of route objects.');
    return undefined;
  }

  const seen = new Set<string>();
  const routes: WorkspaceRoute[] = [];
  raw.forEach((entry, index) => {
    const at = `routes[${index}]`;
    if (!isRecord(entry)) {
      fail(at, 'Each route must be an object with "id", "match" and "step".');
      return;
    }
    rejectUnknown(entry, ['id', 'match', 'step'], at, fail);
    const id = parseStableId(entry.id, `${at}.id`, 'route', fail);
    const duplicateId = id !== null && seen.has(id);
    if (duplicateId) fail(`${at}.id`, `Two routes are both called "${id}".`);
    else if (id !== null) seen.add(id);
    const step = parseStableId(entry.step, `${at}.step`, 'route step', fail);
    if (step !== null && !stepIds.has(step)) {
      fail(`${at}.step`, `Unknown step "${step}". Declare it under "steps" first.`);
    }

    const match = parseRouteMatch(entry.match, `${at}.match`, fail);
    if (id === null || step === null || !stepIds.has(step) || match === null) return;
    if (duplicateId) return;
    routes.push({ id, match, step });
  });
  return routes;
}

function parseRouteMatch(
  raw: unknown,
  at: string,
  fail: (path: string, message: string) => void,
): WorkspaceRoute['match'] | null {
  if (!isRecord(raw)) {
    fail(at, 'A route matcher must be an object with label lists.');
    return null;
  }
  rejectUnknown(raw, ['allLabels', 'anyLabels', 'noneLabels'], at, fail);

  const match: WorkspaceRoute['match'] = {};
  let hasNonEmptyList = false;
  let valid = true;
  for (const key of ['allLabels', 'anyLabels', 'noneLabels'] as const) {
    const rawLabels = raw[key];
    if (rawLabels === undefined) continue;
    if (!Array.isArray(rawLabels)) {
      fail(`${at}.${key}`, `"${key}" must be an array of non-empty labels.`);
      valid = false;
      continue;
    }
    if (rawLabels.length > 0) hasNonEmptyList = true;
    const labels: string[] = [];
    const seenLabels = new Set<string>();
    rawLabels.forEach((label, index) => {
      if (typeof label !== 'string' || label.trim() === '') {
        fail(`${at}.${key}[${index}]`, 'Labels must be non-empty strings.');
        valid = false;
        return;
      }
      const normalized = label.trim();
      if (seenLabels.has(normalized)) {
        fail(`${at}.${key}[${index}]`, `Label "${normalized}" appears more than once in "${key}".`);
        valid = false;
        return;
      }
      seenLabels.add(normalized);
      labels.push(normalized);
    });
    match[key] = labels;
  }

  if (!hasNonEmptyList) {
    fail(at, 'A route matcher must contain at least one non-empty label list.');
    valid = false;
  }
  const required = new Set(match.allLabels ?? []);
  const forbidden = new Set(match.noneLabels ?? []);
  for (const label of required) {
    if (forbidden.has(label)) {
      fail(`${at}.noneLabels`, `Label "${label}" cannot be both required by "allLabels" and forbidden by "noneLabels".`);
      valid = false;
    }
  }
  const anyLabels = match.anyLabels ?? [];
  if (anyLabels.length > 0 && anyLabels.every((label) => forbidden.has(label))) {
    fail(`${at}.anyLabels`, 'Every label in "anyLabels" is forbidden by "noneLabels", so this matcher cannot match.');
    valid = false;
  }
  return valid ? match : null;
}

function parseStableId(
  value: unknown,
  path: string,
  kind: string,
  fail: (path: string, message: string) => void,
): string | null {
  if (typeof value !== 'string' || !STABLE_ID_RE.test(value)) {
    fail(path, `A ${kind} id must use lowercase letters, digits and hyphens, starting with a letter or digit.`);
    return null;
  }
  return value;
}

function parseHumanText(
  value: unknown,
  path: string,
  kind: string,
  fail: (path: string, message: string) => void,
): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(path, `A ${kind} must be a non-empty string.`);
    return null;
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  fail: (path: string, message: string) => void,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`${prefix}.${key}`, `Unknown setting "${key}". "${prefix}" understands: ${allowed.join(', ')}.`);
    }
  }
}

/**
 * Why a value can't be a path inside the workspace, or null when it can.
 *
 * Absolute paths are refused because they are the machine-specific thing this file is
 * meant not to contain: `C:\Users\me\...` in a committed declaration is broken for
 * everyone but its author. `..` is refused because a workspace that reaches outside its
 * own root is not a workspace. Backslashes are refused because the same file is read on
 * Windows and Linux, and only one of them treats them as separators.
 */
function relativePathProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return 'Must be a non-empty path.';
  const path = value.trim();
  if (path.includes('\\')) return 'Use forward slashes; this file is read on every platform.';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    return 'Must be relative to the workspace root, not an absolute path.';
  }
  if (path.split('/').includes('..')) return 'Must stay inside the workspace root.';
  return null;
}
