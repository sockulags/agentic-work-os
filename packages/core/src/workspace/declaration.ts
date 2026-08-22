import { AGENT_IDS, WORKSPACE_SCHEMA_VERSION } from '@awos/protocol';
import type { AgentId, VerifyCommand, WorkspaceProblem } from '@awos/protocol';

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
  context?: { references?: string[]; notes?: string };
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
  'context',
] as const;

const MAX_NAME_CHARS = 80;
const MAX_REFERENCES = 20;

/** Lowercase and hyphenated, because later gates will name these on a command line. */
const VERIFY_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

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
  } else if (version !== WORKSPACE_SCHEMA_VERSION) {
    fail(
      'version',
      `Schema version ${version} is not supported. This build understands version ` +
        `${WORKSPACE_SCHEMA_VERSION}; upgrade Agentic Work OS or lower the version.`,
    );
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

  return {
    declaration: problems.some((problem) => problem.severity === 'error') ? null : declaration,
    problems,
  };
}

// ---------------------------------------------------------------------------

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
