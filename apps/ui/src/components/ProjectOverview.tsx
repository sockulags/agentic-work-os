import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDot, ExternalLink, Grid2X2, RefreshCw, XCircle } from 'lucide-react';
import type {
  AgentId,
  IssuePreparation,
  ProjectOverview as ProjectOverviewModel,
  ProjectOverviewGroup,
  ProjectOverviewItem,
} from '@awos/protocol';
import { useHarnessContext } from '@/state/HarnessContext';
import { WorkspaceRoleSelector } from '@/components/WorkspaceRoleSelector';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn, formatRelative } from '@/lib/utils';

const GROUPS: readonly {
  id: ProjectOverviewGroup;
  title: string;
  hint: string;
  label: string;
}[] = [
  { id: 'available', title: 'Available', hint: 'Ready for your role', label: 'Ready for your role' },
  { id: 'active', title: 'Active', hint: 'Local work in progress', label: 'Local work' },
  { id: 'blocked', title: 'Blocked', hint: 'Needs attention before Take', label: 'Needs attention' },
];

interface ProjectOverviewProps {
  cwd: string | null;
  onOpenThread: (threadId: string) => void;
}

interface PendingPreparation {
  item: ProjectOverviewItem;
  preparation: IssuePreparation;
}

/** The production project-level entry surface. It consumes only the core read model. */
export function ProjectOverview({ cwd, onOpenThread }: ProjectOverviewProps): React.JSX.Element {
  const h = useHarnessContext();
  const [pending, setPending] = useState<PendingPreparation | null>(null);
  const [selectedWorker, setSelectedWorker] = useState<AgentId | null>(null);
  const [actionBusy, setActionBusy] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [preparationError, setPreparationError] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  useEffect(() => {
    if (cwd === null) return;
    void h.openProjectOverview(cwd);
    return () => h.closeProjectOverview(cwd);
  }, [cwd, h.openProjectOverview, h.closeProjectOverview]);

  const view = h.projectOverview;
  const model = view?.cwd === cwd ? view.overview : null;
  const grouped = useMemo(() => {
    const groups: Record<ProjectOverviewGroup, ProjectOverviewItem[]> = {
      available: [],
      active: [],
      blocked: [],
    };
    for (const item of model?.items ?? []) groups[item.group].push(item);
    return groups;
  }, [model]);

  async function runAction(item: ProjectOverviewItem): Promise<void> {
    if (cwd === null || item.action === 'none') return;
    setActionBusy(item.issue.number);
    setActionError(null);
    setPreparationError(null);
    try {
      const result = await h.openIssue(cwd, item.issue.number);
      if (!result.ok) {
        setActionError(result.message);
        return;
      }
      setSelectedWorker(result.preparation.mode === 'taken'
        ? result.preparation.currentlyAvailableWorkerProfileIds[0] ?? null
        : null);
      setPending({ item, preparation: result.preparation });
      void h.refreshProjectOverview(cwd);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not prepare this issue.');
    } finally {
      setActionBusy(null);
    }
  }

  async function confirmPreparation(): Promise<void> {
    if (pending === null) return;
    setPreparationError(null);
    if (pending.preparation.mode === 'taken') {
      const allowed = pending.preparation.allowedWorkerProfileIds;
      const available = pending.preparation.currentlyAvailableWorkerProfileIds;
      if (selectedWorker === null || !allowed.includes(selectedWorker) || !available.includes(selectedWorker)) {
        setPreparationError('Choose an available worker before opening this thread.');
        return;
      }
      setConfirmBusy(true);
      try {
        await h.setThreadAgent(pending.preparation.threadId, selectedWorker);
      } catch (error) {
        setPreparationError(error instanceof Error ? error.message : 'Could not save the selected worker.');
        return;
      } finally {
        setConfirmBusy(false);
      }
    }
    const threadId = pending.preparation.threadId;
    setPending(null);
    onOpenThread(threadId);
  }

  if (cwd === null) {
    return (
      <div className="project-overview-empty" role="status">
        <Grid2X2 aria-hidden="true" />
        <h1>Project overview</h1>
        <p>Open or create a thread to choose the nearest workspace.</p>
      </div>
    );
  }

  if (view === null || view.cwd !== cwd || (view.overview === null && view.busy)) {
    return <OverviewLoading cwd={cwd} />;
  }

  if (model === null) {
    return (
      <div className="project-overview-empty" role={view.error ? 'alert' : 'status'}>
        <XCircle aria-hidden="true" />
        <h1>Project overview</h1>
        <p>{view.error?.message ?? 'This directory does not resolve to a project workspace.'}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void h.refreshProjectOverview(cwd)}>
          <RefreshCw data-icon="inline-start" />
          Read workspace again
        </Button>
      </div>
    );
  }

  return (
    <div className="project-overview-shell awos-scroll">
      <header className="project-overview-topbar">
        <div className="project-overview-breadcrumbs" aria-label="Breadcrumb">
          <span>Workspace</span>
          <span aria-hidden="true">/</span>
          <strong>Project overview</strong>
        </div>
        <div className="project-overview-top-actions">
          {model.workspace.roles.length > 0 && (
            <WorkspaceRoleSelector
              roles={[...model.workspace.roles]}
              selection={model.roleSelection}
              save={h.roleSelectionSave}
              error={h.roleSelectionError}
              onChange={(roleId) => void h.setProjectOverviewRole(cwd, roleId)}
              label="Active role"
              layout="inline"
            />
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={view.busy}
            onClick={() => void h.refreshProjectCatalog(cwd)}
          >
            <RefreshCw data-icon="inline-start" className={cn(view.busy && 'animate-spin')} />
            Refresh issues
          </Button>
        </div>
      </header>

      <main className="project-overview-content">
        <section className="project-overview-intro" aria-labelledby="project-overview-title">
          <div>
            <h1 id="project-overview-title">{model.workspace.name}</h1>
            <p className="project-overview-lede">
              Find work your role can own, see why an issue is blocked, and prepare the next step without dispatching a worker.
            </p>
          </div>
          <p className="project-overview-intro-note">
            <strong>Local overlay</strong>
            Role selection, prepared steps, and active thread state live here. GitHub remains the source of issue truth.
          </p>
        </section>

        <SourceNotice model={model} viewError={view.error} onRefresh={() => void h.refreshProjectCatalog(cwd)} />

        <div className="project-overview-toolbar" aria-label="Issue catalog status">
          <span className="project-overview-toolbar-label">Issue work</span>
          <span className="project-overview-refresh-status" role="status" aria-live="polite">
            {catalogStatus(model)}
          </span>
        </div>

        {actionError !== null && (
          <div className="project-overview-action-error" role="alert">
            <XCircle aria-hidden="true" />
            <span>{actionError}</span>
            <button type="button" className="awos-focus-ring project-overview-dismiss" onClick={() => setActionError(null)}>
              Dismiss
            </button>
          </div>
        )}

        <section className="project-overview-groups" aria-label="Issues grouped by local workflow state">
          {GROUPS.map((group) => (
            <OverviewGroup
              key={group.id}
              group={group}
              items={grouped[group.id]}
              actionBusy={actionBusy}
              onAction={(item) => void runAction(item)}
            />
          ))}
        </section>
      </main>

      <PreparationDialog
        pending={pending}
        selectedWorker={selectedWorker}
        onSelectWorker={setSelectedWorker}
        onClose={() => { setPending(null); setPreparationError(null); }}
        onConfirm={confirmPreparation}
        preparationError={preparationError}
        confirmBusy={confirmBusy}
        workerLabels={new Map(model.items.flatMap((item) => item.workers.map((worker) => [worker.profileId, worker.label] as const)))}
      />
    </div>
  );
}

function OverviewLoading({ cwd }: { cwd: string }): React.JSX.Element {
  return (
    <div className="project-overview-empty" role="status" aria-live="polite">
      <RefreshCw className="animate-spin" aria-hidden="true" />
      <h1>Project overview</h1>
      <p>Reading the workspace and issue catalog for <span className="font-mono">{cwd}</span>…</p>
    </div>
  );
}

function SourceNotice({
  model,
  viewError,
  onRefresh,
}: {
  model: ProjectOverviewModel;
  viewError: { message: string } | null;
  onRefresh: () => void;
}): React.JSX.Element | null {
  const sourceError = model.source.error;
  const readError = sourceError === null ? viewError : null;
  if (sourceError !== null) {
    return (
      <section className="project-overview-source-notice stale" aria-label="GitHub source status" role="alert">
        <AlertTriangle className="project-overview-source-icon" aria-hidden="true" />
        <div>
          <strong>GitHub source unavailable</strong>
          <p>
            {model.source.successfulAt === null
              ? 'No catalog has been fetched. Refresh GitHub before taking new work.'
              : `Showing the cached catalog from ${formatDateTime(model.source.successfulAt)}. Refresh GitHub before taking new work; linked Continue remains available.`}
          </p>
          {sourceError.message !== '' && <p className="project-overview-source-detail">{sourceError.message}</p>}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
          Refresh required
        </Button>
      </section>
    );
  }

  if (readError !== null) {
    return (
      <section className="project-overview-source-notice" aria-label="Project overview status" role="alert">
        <AlertTriangle className="project-overview-source-icon" aria-hidden="true" />
        <div>
          <strong>Project overview needs a refresh</strong>
          <p>{readError.message || 'The latest workspace state could not be read.'} Local linked work remains visible from the last read.</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRefresh}>Try again</Button>
      </section>
    );
  }

  if (model.source.freshness === 'not-fetched') {
    return (
      <section className="project-overview-source-notice" aria-label="GitHub source status" role="status">
        <AlertTriangle className="project-overview-source-icon" aria-hidden="true" />
        <div>
          <strong>GitHub catalog not fetched</strong>
          <p>Refresh GitHub to load open issues. Local linked work will remain visible if the source is unavailable.</p>
        </div>
      </section>
    );
  }

  if (model.source.freshness === 'cached') {
    return (
      <section className="project-overview-source-notice stale" aria-label="GitHub source status" role="status">
        <AlertTriangle className="project-overview-source-icon" aria-hidden="true" />
        <div>
          <strong>Showing cached GitHub issues</strong>
          <p>Last successful refresh: {model.source.successfulAt === null ? 'unknown' : formatDateTime(model.source.successfulAt)}. Refresh before taking new work.</p>
        </div>
      </section>
    );
  }

  if (!model.source.complete) {
    return (
      <section className="project-overview-source-notice" aria-label="GitHub catalog status" role="status">
        <AlertTriangle className="project-overview-source-icon" aria-hidden="true" />
        <div>
          <strong>Catalog is incomplete</strong>
          <p>Showing the first page of open GitHub issues. Refresh to check the source again.</p>
        </div>
      </section>
    );
  }

  return null;
}

function OverviewGroup({
  group,
  items,
  actionBusy,
  onAction,
}: {
  group: (typeof GROUPS)[number];
  items: ProjectOverviewItem[];
  actionBusy: number | null;
  onAction: (item: ProjectOverviewItem) => void;
}): React.JSX.Element {
  const titleId = `project-overview-${group.id}-title`;
  return (
    <section className={cn('project-overview-group', group.id === 'blocked' && 'blocked-group')} aria-labelledby={titleId}>
      <header className="project-overview-group-header">
        <div>
          <h2 id={titleId} className="project-overview-group-title">
            <GroupIcon group={group.id} aria-hidden="true" />
            {group.title}
            <span className="project-overview-count" aria-hidden="true">{items.length}</span>
          </h2>
          <p className="project-overview-group-hint">{group.hint}</p>
        </div>
        <span className={cn('project-overview-chip', group.id === 'blocked' ? 'blocked' : group.id === 'active' ? 'waiting' : 'ready')}>
          {group.label}
        </span>
      </header>
      <div className="project-overview-list">
        {items.length === 0 ? (
          <p className="project-overview-empty-note">
            {group.id === 'available' ? 'No role-owned work is ready to take.' : group.id === 'active' ? 'No linked local work.' : 'Nothing is blocked.'}
          </p>
        ) : (
          items.map((item) => (
            <IssueRow key={`${item.issue.url}:${item.issue.number}`} item={item} actionBusy={actionBusy} onAction={onAction} />
          ))
        )}
      </div>
    </section>
  );
}

function IssueRow({
  item,
  actionBusy,
  onAction,
}: {
  item: ProjectOverviewItem;
  actionBusy: number | null;
  onAction: (item: ProjectOverviewItem) => void;
}): React.JSX.Element {
  const busy = actionBusy === item.issue.number;
  return (
    <article className="project-overview-issue">
      <div className="project-overview-issue-top">
        <span className="project-overview-issue-number font-mono">#{item.issue.number}</span>
        <span className={cn('project-overview-chip', chipTone(item))}>{item.statusLabel}</span>
      </div>
      <h3>
        <a href={item.issue.url} target="_blank" rel="noreferrer" className="project-overview-title-link">
          {item.issue.title}
          <ExternalLink aria-hidden="true" />
        </a>
      </h3>
      <div className="project-overview-issue-meta">
        <span className="project-overview-action-label">{item.projectAction ?? (item.linkedWork === null ? 'No project action' : 'Local thread')}</span>
        <span>{item.responsibleRole?.label ?? (item.linkedWork === null ? 'No responsible role' : 'Local work')}</span>
        <WorkerSummary item={item} />
      </div>
      <div className="project-overview-issue-actions">
        {item.action === 'take' && (
          <Button type="button" size="sm" onClick={() => onAction(item)} disabled={busy}>
            {busy ? <RefreshCw data-icon="inline-start" className="animate-spin" /> : <CheckCircle2 data-icon="inline-start" />}
            {busy ? 'Preparing…' : 'Take issue'}
          </Button>
        )}
        {item.action === 'continue' && (
          <Button type="button" size="sm" onClick={() => onAction(item)} disabled={busy}>
            {busy ? <RefreshCw data-icon="inline-start" className="animate-spin" /> : <CircleDot data-icon="inline-start" />}
            {busy ? 'Opening…' : 'Continue'}
          </Button>
        )}
        {item.action === 'none' && <span className="project-overview-unavailable">No action available</span>}
      </div>
      <p className={cn('project-overview-reason', item.group === 'blocked' && 'blocked', item.reasonCode === 'available' && 'ready')}>
        {item.reason}
      </p>
    </article>
  );
}

function WorkerSummary({ item }: { item: ProjectOverviewItem }): React.JSX.Element {
  if (item.workers.length === 0) return <span>No worker selected</span>;
  const available = item.workers.filter((worker) => worker.available).map((worker) => worker.label);
  return <span>{available.length === 0 ? 'No allowed worker available' : `${available.join(', ')} available`}</span>;
}

function PreparationDialog({
  pending,
  selectedWorker,
  onSelectWorker,
  onClose,
  onConfirm,
  preparationError,
  confirmBusy,
  workerLabels,
}: {
  pending: PendingPreparation | null;
  selectedWorker: AgentId | null;
  onSelectWorker: (profileId: AgentId) => void;
  onClose: () => void;
  onConfirm: () => void;
  preparationError: string | null;
  confirmBusy: boolean;
  workerLabels: Map<AgentId, string>;
}): React.JSX.Element {
  const preparation = pending?.preparation ?? null;
  const isTake = preparation?.mode === 'taken';
  const available = new Set(preparation?.currentlyAvailableWorkerProfileIds ?? []);
  const workers = preparation?.allowedWorkerProfileIds ?? [];
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="project-overview-dialog">
        <DialogTitle>{isTake ? 'Prepare a step' : 'Continue linked work'}</DialogTitle>
        <DialogDescription>
          {isTake
            ? 'This prepares a local step. No worker will be launched.'
            : 'The existing thread remains the destination, even if GitHub is unavailable.'}
        </DialogDescription>
        {preparation !== null && (
          <>
            <div className="project-overview-flow" aria-label="Preparation steps">
              <div className="project-overview-flow-step current"><span>1</span><div><strong>{isTake ? 'Prepared step' : 'Existing linked thread'}</strong><small>{isTake ? `${preparation.route?.action ?? 'Project action'} · #${preparation.instruction.issueNumber}` : 'Same local destination'}</small></div></div>
              <div className="project-overview-flow-step"><span>2</span><div><strong>{isTake ? 'Choose worker' : 'Same destination'}</strong><small>{isTake ? 'Pick an allowed worker; nothing starts yet.' : 'Continue reopens the same thread.'}</small></div></div>
              <div className="project-overview-flow-step"><span>3</span><div><strong>{isTake ? 'Confirm instruction' : 'Open thread'}</strong><small>{isTake ? 'Review what would be handed to the selected worker.' : 'The thread opens in the existing work surface.'}</small></div></div>
            </div>

            {isTake && (
              <fieldset className="project-overview-worker-choice">
                <legend>Allowed workers for this step</legend>
                {workers.length === 0 ? (
                  <p className="project-overview-dialog-note">No worker choice was returned.</p>
                ) : workers.map((profileId) => (
                  <label key={profileId} className={cn('project-overview-worker-option', selectedWorker === profileId && 'selected')}>
                    <input
                      type="radio"
                      name="project-overview-worker"
                      value={profileId}
                      checked={selectedWorker === profileId}
                      disabled={!available.has(profileId)}
                      onChange={() => onSelectWorker(profileId)}
                    />
                    <span><strong>{workerLabels.get(profileId) ?? 'Worker'}</strong><small>{available.has(profileId) ? 'Available for this step' : 'Unavailable for this step'}</small></span>
                  </label>
                ))}
              </fieldset>
            )}

            <div className="project-overview-instruction">
              <strong>{isTake ? 'Instruction preview' : 'What Continue does'}</strong>
              <p>
                {isTake
                  ? `Work on issue #${preparation.instruction.issueNumber} using the prepared ${preparation.route?.action ?? 'project'} step. Confirming this does not start a worker.`
                  : 'Continue reopens the same linked thread and keeps its prepared destination. It does not start a worker.'}
              </p>
            </div>

            {preparationError !== null && (
              <div className="project-overview-action-error" role="alert">
                <XCircle aria-hidden="true" />
                <span>{preparationError}</span>
              </div>
            )}

            <div className="project-overview-dialog-footer">
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button type="button" onClick={onConfirm} disabled={confirmBusy || (isTake && workers.length > 0 && selectedWorker === null)}>
                {confirmBusy ? 'Saving worker…' : isTake ? 'Confirm preparation only' : 'Open same thread'}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function GroupIcon({ group, ...props }: { group: ProjectOverviewGroup } & React.SVGProps<SVGSVGElement>): React.JSX.Element {
  const Icon = group === 'available' ? CheckCircle2 : group === 'active' ? CircleDot : XCircle;
  return <Icon className="project-overview-group-icon" {...props} />;
}

function chipTone(item: ProjectOverviewItem): 'ready' | 'waiting' | 'blocked' | 'interrupted' | 'neutral' {
  if (item.group === 'active') return item.reasonCode === 'active-interrupted' ? 'interrupted' : 'waiting';
  if (item.reasonCode === 'available') return 'ready';
  if (item.reasonCode === 'role-required' || item.reasonCode === 'role-mismatch' || item.reasonCode === 'refresh-required') return 'waiting';
  if (item.group === 'blocked') return 'blocked';
  return 'neutral';
}

function catalogStatus(model: ProjectOverviewModel): string {
  if (model.source.freshness === 'current') {
    return model.source.successfulAt === null ? 'Current GitHub catalog' : `Last refreshed ${formatRelative(model.source.successfulAt)}`;
  }
  if (model.source.freshness === 'cached') {
    return model.source.successfulAt === null ? 'Cached catalog' : `Cached from ${formatDateTime(model.source.successfulAt)}`;
  }
  return 'No GitHub refresh yet';
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
