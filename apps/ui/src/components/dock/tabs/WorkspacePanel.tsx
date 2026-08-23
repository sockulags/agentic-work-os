import { AlertTriangle, RefreshCw, XCircle } from 'lucide-react';
import {
  WORKSPACE_FILE,
  WORKSPACE_SCHEMA_VERSION,
  type EffectiveWorkspace,
  type WorkspaceOrigin,
  type WorkspaceProblem,
} from '@awos/protocol';
import { useHarnessContext } from '@/state/HarnessContext';
import { cn } from '@/lib/utils';
import { ReviewState } from '@/components/review/ReviewPatterns';

/**
 * What the project itself says about how work happens here.
 *
 * Shows the effective settings rather than the file: the point of the panel is the answer
 * after every layer has been applied, which is not something you can read off any one of
 * them. Each value carries where it came from, because a setting that surprises you is
 * only actionable once you know which file to open.
 *
 * The declaration is edited outside this app, and the core does not watch it, so the
 * panel offers to look again rather than pretending to be live.
 */
export function WorkspacePanel(): React.JSX.Element {
  const { activeThreadId, workspace, refreshWorkspace } = useHarnessContext();

  if (activeThreadId === null) {
    return (
      <div className="space-y-1 px-4 py-3 text-xs">
        <ReviewState state="idle" label="No thread selected" />
        <p className="text-muted-foreground">Open a thread to see the workspace its directory belongs to.</p>
      </div>
    );
  }

  if (workspace === null) {
    return (
      <div className="space-y-1 px-4 py-3 text-xs">
        <ReviewState state="busy" />
        <p className="text-muted-foreground">Reading the declaration…</p>
      </div>
    );
  }

  const { cwd, resolution } = workspace;

  return (
    <div className="awos-scroll h-full space-y-3 overflow-y-auto px-4 py-3 text-xs">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={cwd}>
          {cwd}
        </p>
        <button
          type="button"
          onClick={() => void refreshWorkspace(cwd)}
          title="Read the declaration again"
          className="shrink-0 rounded-md border border-input px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      {resolution.status === 'none' && <Undeclared />}

      {resolution.status === 'invalid' && (
        <>
          <p className="text-destructive">
            This project has a {WORKSPACE_FILE} that does not load, so none of its settings are in
            effect.
          </p>
          <Problems problems={resolution.problems} />
        </>
      )}

      {resolution.status === 'ok' && (
        <>
          <Settings workspace={resolution.workspace} />
          <Problems problems={resolution.problems} />
          <p className="pt-1 text-[10px] text-muted-foreground">
            Read from {resolution.workspace.sources.join(', ')}
          </p>
        </>
      )}
    </div>
  );
}

function Settings({ workspace }: { workspace: EffectiveWorkspace }): React.JSX.Element {
  return (
    <dl className="space-y-2">
      <Row label="Name" origin={workspace.origins.name}>
        {workspace.name}
      </Row>

      <Row label="Repository" origin={workspace.origins.repository}>
        <span className="font-mono">{workspace.repository.root}</span>
        {workspace.repository.github && <> · {workspace.repository.github}</>}
      </Row>

      <Row label="Agents" origin={workspace.origins.agents}>
        {workspace.agents.join(', ')}
      </Row>

      <Row label="Setup" origin={workspace.origins.setup}>
        {workspace.setup.command === '' ? (
          <span className="text-muted-foreground">
            none — a fresh lane holds only what git tracks
          </span>
        ) : (
          <span className="font-mono break-all">{workspace.setup.command}</span>
        )}
      </Row>

      <Row label="Verify" origin={workspace.origins.verify}>
        {workspace.verify.length === 0 ? (
          <span className="text-muted-foreground">none declared</span>
        ) : (
          <ul className="space-y-0.5">
            {workspace.verify.map((entry) => (
              <li key={entry.name}>
                {entry.name} — <span className="font-mono break-all">{entry.command}</span>
              </li>
            ))}
          </ul>
        )}
      </Row>

      <Row label="Context" origin={workspace.origins.context}>
        {workspace.context.references.length === 0 && workspace.context.notes.trim() === '' ? (
          <span className="text-muted-foreground">none declared</span>
        ) : (
          <>
            {workspace.context.references.length > 0 && (
              <p className="font-mono break-all">{workspace.context.references.join(', ')}</p>
            )}
            {workspace.context.notes.trim() !== '' && (
              <p className="whitespace-pre-wrap text-muted-foreground">{workspace.context.notes}</p>
            )}
          </>
        )}
      </Row>
    </dl>
  );
}

/**
 * One setting with its provenance.
 *
 * The origin is shown for every field, including the ones nobody declared: "default" is
 * the answer to the same question, and hiding it would make a value with no visible source
 * look like an unexplained one.
 */
function Row({
  label,
  origin,
  children,
}: {
  label: string;
  origin: WorkspaceOrigin;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-0.5">
      <dt className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
        <span
          className={cn(
            'rounded px-1 py-px text-[9px] normal-case tracking-normal',
            origin === 'shared' && 'bg-muted text-muted-foreground',
            origin === 'local' && 'bg-state-stale-surface text-state-stale',
            origin === 'environment' && 'bg-state-waiting-surface text-state-waiting',
            origin === 'default' && 'text-muted-foreground/60',
          )}
          title={ORIGIN_TITLE[origin]}
        >
          {origin}
        </span>
      </dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

const ORIGIN_TITLE: Record<WorkspaceOrigin, string> = {
  shared: `Declared in ${WORKSPACE_FILE}, committed with the repository`,
  local: 'Overridden on this machine only',
  environment: 'From an AWOS_ environment variable, because the project declared none',
  default: 'Nothing declares this, so the harness default applies',
};

function Problems({ problems }: { problems: WorkspaceProblem[] }): React.JSX.Element | null {
  if (problems.length === 0) return null;

  return (
    <ul className="space-y-1.5 border-t border-border pt-2">
      {problems.map((problem, index) => (
        <li key={`${problem.file}:${problem.path}:${index}`} className="flex items-start gap-1.5">
          {problem.severity === 'error' ? (
            <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
          ) : (
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-state-stale" />
          )}
          <span className="min-w-0">
            <span className="font-mono text-[10px] text-muted-foreground">
              {problem.file}
              {problem.path !== '' && ` · ${problem.path}`}
            </span>
            <br />
            {problem.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Not every directory is a project, so this says what one would look like rather than nagging. */
function Undeclared(): React.JSX.Element {
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground">
        This directory is not a workspace. Threads work here exactly as they always have; what is
        missing is anything the project itself declares.
      </p>
      <p className="text-muted-foreground">
        Create <span className="font-mono">{WORKSPACE_FILE}</span> and commit it:
      </p>
      <pre className="awos-scroll overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-[10px] leading-relaxed">
        {JSON.stringify(
          {
            version: WORKSPACE_SCHEMA_VERSION,
            name: 'my-project',
            agents: ['claude', 'codex', 'qwen-local'],
            setup: { command: 'npm install' },
            verify: [{ name: 'test', command: 'npm test' }],
          },
          null,
          2,
        )}
      </pre>
    </div>
  );
}
