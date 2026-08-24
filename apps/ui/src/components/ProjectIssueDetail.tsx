import { useEffect } from 'react';
import { AlertTriangle, CircleDot, ExternalLink, RefreshCw, X, XCircle, CheckCircle2 } from 'lucide-react';
import type { ProjectIssueDetail as ProjectIssueDetailModel, ProjectIssueTimelineEntry, ProjectOverviewItem, WorkSourceError } from '@awos/protocol';
import { Button } from '@/components/ui/button';
import { EvidenceItem, ReviewState, type ReviewStateName } from '@/components/review/ReviewPatterns';
import { Markdown } from '@/components/Markdown';
import { cn, formatRelative } from '@/lib/utils';

interface ProjectIssueDetailProps {
  detail: ProjectIssueDetailModel | null;
  selectedItem: ProjectOverviewItem;
  error: WorkSourceError | null;
  loading: boolean;
  actionBusy: boolean;
  headingRef: React.RefObject<HTMLHeadingElement>;
  onClose: () => void;
  onAction: (item: ProjectOverviewItem) => void;
}

/** The persistent progressive-disclosure surface selected by the accepted overview concept. */
export function ProjectIssueDetail({
  detail,
  selectedItem,
  error,
  loading,
  actionBusy,
  headingRef,
  onClose,
  onAction,
}: ProjectIssueDetailProps): React.JSX.Element {
  const headingId = `project-issue-detail-title-${selectedItem.issue.number}`;
  const action = detail?.action.action ?? 'none';

  useEffect(() => {
    headingRef.current?.focus();
  }, [headingRef, selectedItem.issue.number]);

  return (
    <aside className="project-issue-detail" aria-labelledby={headingId}>
      <header className="project-issue-detail-header">
        <div className="min-w-0 flex-1">
          <p className="project-issue-detail-kicker">Selected issue details</p>
          <h2 id={headingId} ref={headingRef} tabIndex={-1}>
            <span className="font-mono">#{selectedItem.issue.number}</span> · {detail?.issue.title ?? selectedItem.issue.title}
          </h2>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close issue details" title="Close issue details">
          <X data-icon="inline-start" aria-hidden="true" />
        </Button>
      </header>

      {loading && (
        <div className="project-issue-detail-loading" role="status" aria-live="polite">
          <RefreshCw className="animate-spin" aria-hidden="true" />
          <span>Reading source detail and local work history…</span>
        </div>
      )}

      {error !== null && (
        <div className="project-issue-detail-source-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{error.message}</span>
        </div>
      )}

      {detail !== null && (
        <>
          <div className="project-issue-detail-topline">
            <span className={cn('project-overview-chip', chipTone(detail.action.reasonCode))}>{detail.action.reasonCode}</span>
            <a href={detail.issue.url} target="_blank" rel="noreferrer" className="project-issue-detail-source-link">
              Open source issue <ExternalLink aria-hidden="true" />
            </a>
          </div>

          <section className="project-issue-detail-section" aria-labelledby={`${headingId}-metadata`}>
            <SectionHeading id={`${headingId}-metadata`}>Source metadata</SectionHeading>
            <dl className="project-issue-detail-facts">
              <Fact label="State" value={detail.issue.state} />
              <Fact label="Author" value={detail.snapshot?.author || 'Not available'} />
              <Fact label="Labels" value={detail.issue.labels.length === 0 ? 'None' : detail.issue.labels.join(' · ')} />
              <Fact label="Assignees" value={assigneesLabel(detail)} />
              <Fact label="Assignee source" value={assigneeSourceLabel(detail.source.assigneesSource)} />
              <Fact label="Source" value={sourceLabel(detail.source.kind, detail.source.freshness)} />
              <Fact label="Catalog" value={detail.source.catalogFreshness} />
              <Fact label="Revision" value={detail.source.revision ?? 'Unknown'} mono />
              <Fact label="Fetched" value={detail.source.fetchedAt === null ? 'Not available' : formatDate(detail.source.fetchedAt)} />
              <Fact label="Checked" value={detail.source.checkedAt === null ? 'Not available' : formatDate(detail.source.checkedAt)} />
            </dl>
            {detail.bodyTruncated && <p className="project-issue-detail-note">The body is capped for this view; the source remains unchanged.</p>}
          </section>

          <section className="project-issue-detail-section" aria-labelledby={`${headingId}-body`}>
            <SectionHeading id={`${headingId}-body`}>Source body</SectionHeading>
            {detail.snapshot === null ? (
              <p className="project-issue-detail-empty">The current catalog contains metadata, but no body snapshot is available.</p>
            ) : detail.snapshot.body.trim() === '' ? (
              <p className="project-issue-detail-empty">This issue has no source body.</p>
            ) : (
              <div className="project-issue-detail-body awos-scroll">
                <Markdown text={detail.snapshot.body} />
              </div>
            )}
          </section>

          <section className="project-issue-detail-section" aria-labelledby={`${headingId}-route`}>
            <SectionHeading id={`${headingId}-route`}>Route and action</SectionHeading>
            <dl className="project-issue-detail-facts">
              <Fact label="Route status" value={detail.route.route.status} />
              <Fact label="Matching routes" value={detail.route.route.matchingRouteIds.length === 0 ? 'None' : detail.route.route.matchingRouteIds.join(' · ')} mono />
              <Fact label="Selected route" value={detail.route.route.routeId ?? 'None'} mono />
              <Fact label="Starting step" value={detail.route.route.stepId ?? 'None'} mono />
              <Fact label="Project action" value={detail.action.projectAction ?? 'None'} />
              <Fact label="Responsible role" value={detail.action.responsibleRole?.label ?? 'None'} />
              <Fact label="Local role" value={detail.route.action.roleSelection.role?.label ?? detail.route.action.roleSelection.roleId ?? detail.route.action.roleSelection.status} />
              <Fact label="Action" value={detail.action.action} />
              <Fact label="Reason code" value={detail.action.reasonCode} mono />
            </dl>
            <div className="project-issue-detail-workers" aria-label="Allowed worker choices">
              <span className="project-issue-detail-label">Allowed worker choices</span>
              {detail.action.workers.length === 0 ? (
                <span className="project-issue-detail-empty">No worker choices returned by the core.</span>
              ) : (
                <ul>
                  {detail.action.workers.map((worker) => (
                    <li key={worker.profileId}>
                      <span className="min-w-0 break-words">{worker.label} <code>{worker.profileId}</code></span>
                      <ReviewState state={worker.available ? 'passed' : 'blocked'} label={worker.available ? 'Available' : 'Unavailable'} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {detail.action.refusal !== null && (
              <div className="project-issue-detail-refusal" role="alert">
                <XCircle aria-hidden="true" />
                <div className="min-w-0">
                  <strong>Structured refusal · <code>{detail.action.refusal.code}</code></strong>
                  <p>{detail.action.refusal.message}</p>
                </div>
              </div>
            )}
            {detail.route.route.workspaceProblems.length > 0 && (
              <ul className="project-issue-detail-problems" aria-label="Workspace preconditions">
                {detail.route.route.workspaceProblems.map((problem) => (
                  <li key={`${problem.path}:${problem.message}`}><code>{problem.path}</code> · {problem.message}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="project-issue-detail-section project-issue-detail-action-section" aria-labelledby={`${headingId}-next-action`}>
            <SectionHeading id={`${headingId}-next-action`}>Next action</SectionHeading>
            <div className="project-issue-detail-action-row">
              {action === 'take' && (
                <Button type="button" size="sm" onClick={() => onAction(selectedItem)} disabled={actionBusy}>
                  {actionBusy ? <RefreshCw data-icon="inline-start" className="animate-spin" /> : <CheckCircle2 data-icon="inline-start" />}
                  {actionBusy ? 'Preparing…' : 'Take issue'}
                </Button>
              )}
              {action === 'continue' && (
                <Button type="button" size="sm" onClick={() => onAction(selectedItem)} disabled={actionBusy}>
                  {actionBusy ? <RefreshCw data-icon="inline-start" className="animate-spin" /> : <CircleDot data-icon="inline-start" />}
                  {actionBusy ? 'Opening…' : 'Continue'}
                </Button>
              )}
              {action === 'none' && <span className="project-overview-unavailable">No action available</span>}
              <p>{detail.action.reason}</p>
            </div>
          </section>

          <section className="project-issue-detail-section" aria-labelledby={`${headingId}-threads`}>
            <SectionHeading id={`${headingId}-threads`}>Linked threads</SectionHeading>
            {detail.linkedThreads.length === 0 ? (
              <p className="project-issue-detail-empty">No local thread is linked to this issue.</p>
            ) : (
              <ul className="project-issue-detail-thread-list awos-scroll">
                {detail.linkedThreads.map((history) => (
                  <li key={history.thread.threadId}>
                    <div className="project-issue-detail-thread-heading">
                      <strong className="min-w-0 break-words">{history.thread.title}</strong>
                      {history.thread.threadId === detail.canonicalThreadId && <span className="project-overview-chip ready">Continue target</span>}
                    </div>
                    <p className="project-issue-detail-thread-meta">
                      <code>{history.thread.threadId}</code> · updated {formatDate(history.thread.updatedAt)} · {history.runs.length} run{history.runs.length === 1 ? '' : 's'} · {history.evidence.length} evidence item{history.evidence.length === 1 ? '' : 's'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {detail.historyTruncated && <p className="project-issue-detail-note">Older local history is omitted from this bounded view.</p>}
          </section>

          <section className="project-issue-detail-section" aria-labelledby={`${headingId}-timeline`}>
            <SectionHeading id={`${headingId}-timeline`}>Run, outcome, and evidence timeline</SectionHeading>
            {detail.timeline.length === 0 ? (
              <p className="project-issue-detail-empty">No run or evidence history has been recorded.</p>
            ) : (
              <ol className="project-issue-detail-timeline awos-scroll">
                {detail.timeline.map((entry) => <TimelineEntry key={entry.id} entry={entry} />)}
              </ol>
            )}
          </section>
        </>
      )}
    </aside>
  );
}

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }): React.JSX.Element {
  return <h3 id={id} className="project-issue-detail-section-heading">{children}</h3>;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={cn('break-words', mono && 'font-mono')} title={value}>{value}</dd>
    </div>
  );
}

function TimelineEntry({ entry }: { entry: ProjectIssueTimelineEntry }): React.JSX.Element {
  if (entry.kind === 'evidence' && entry.evidence !== null) {
    return (
      <li className="project-issue-detail-timeline-entry">
        <div className="project-issue-detail-timeline-marker" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="project-issue-detail-timeline-label">Evidence · {entry.threadTitle}</div>
          <ul className="mt-2"><EvidenceItem item={entry.evidence} /></ul>
        </div>
      </li>
    );
  }

  if (entry.kind === 'thread') {
    return <TimelineLine entry={entry} label="Linked thread" detail={entry.threadTitle} />;
  }

  if (entry.kind === 'outcome' && entry.outcome !== null) {
    return (
      <TimelineLine
        entry={entry}
        label={`Outcome · ${entry.outcome.claim}`}
        detail={entry.outcome.statement}
        state={outcomeState(entry.outcome.claim)}
      />
    );
  }

  const run = entry.run;
  return (
    <TimelineLine
      entry={entry}
      label={run === null ? 'Run' : run.interruptedByRestart ? 'Interrupted by restart' : run.state}
      detail={run === null ? entry.threadTitle : `${run.agent ?? 'Unknown worker'} · ${entry.threadTitle}`}
      state={run === null ? 'idle' : runState(run)}
    />
  );
}

function TimelineLine({
  entry,
  label,
  detail,
  state,
}: {
  entry: ProjectIssueTimelineEntry;
  label: string;
  detail: string;
  state?: ReviewStateName;
}): React.JSX.Element {
  return (
    <li className="project-issue-detail-timeline-entry">
      <div className="project-issue-detail-timeline-marker" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {state && <ReviewState state={state} label={label} />}
          {!state && <span className="project-issue-detail-timeline-label">{label}</span>}
          <time className="project-issue-detail-thread-meta" dateTime={new Date(entry.at).toISOString()}>{formatRelative(entry.at)}</time>
        </div>
        <p className="project-issue-detail-timeline-copy">{detail}</p>
        <p className="project-issue-detail-thread-meta"><code>{entry.threadId}</code>{entry.runId && <> · run <code>{entry.runId}</code></>}</p>
      </div>
    </li>
  );
}

function runState(run: NonNullable<ProjectIssueTimelineEntry['run']>): ReviewStateName {
  if (run.interruptedByRestart || run.state === 'interrupted') return 'interrupted';
  if (run.state === 'running') return 'busy';
  if (run.state === 'completed') return 'passed';
  return 'failed';
}

function outcomeState(claim: NonNullable<ProjectIssueTimelineEntry['outcome']>['claim']): ReviewStateName {
  switch (claim) {
    case 'delivered': return 'passed';
    case 'blocked': return 'blocked';
    case 'partial': return 'waiting';
    case 'abandoned': return 'interrupted';
  }
}

function chipTone(reasonCode: ProjectIssueDetailModel['action']['reasonCode']): 'ready' | 'waiting' | 'blocked' | 'interrupted' | 'neutral' {
  if (reasonCode === 'available') return 'ready';
  if (reasonCode === 'active') return 'waiting';
  if (reasonCode === 'active-interrupted') return 'interrupted';
  if (reasonCode === 'role-required' || reasonCode === 'role-mismatch' || reasonCode === 'refresh-required') return 'waiting';
  if (reasonCode === 'closed' || reasonCode === 'not-routed' || reasonCode === 'conflicted-route' || reasonCode === 'worker-unavailable' || reasonCode === 'invalid-workspace') return 'blocked';
  return 'neutral';
}

function sourceLabel(kind: ProjectIssueDetailModel['source']['kind'], freshness: ProjectIssueDetailModel['source']['freshness']): string {
  if (kind === 'github') return `GitHub · ${freshness}`;
  if (kind === 'work-item-snapshot') return `Local WorkItem snapshot · ${freshness}`;
  return `Catalog metadata · ${freshness}`;
}

function assigneesLabel(detail: ProjectIssueDetailModel): string {
  if (!detail.source.assigneesKnown) return 'Not available';
  return detail.issue.assignees.length === 0 ? 'None' : detail.issue.assignees.join(' · ');
}

function assigneeSourceLabel(source: ProjectIssueDetailModel['source']['assigneesSource']): string {
  if (source === 'catalog') return 'Current catalog metadata';
  if (source === 'work-item-snapshot') return 'WorkItem snapshot (assignees not retained)';
  return 'Unavailable';
}

function formatDate(value: number): string {
  return `${new Date(value).toLocaleDateString()} ${new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
