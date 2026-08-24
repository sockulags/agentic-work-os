import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentAvailability,
  AgentId,
  HarnessEvent,
  PermissionMode,
  ThreadRuntimeState,
  EvidenceKind,
  EvidenceRef,
  RequirementResult,
  WorkingState,
  RetainedItem,
  RetainedKind,
  RunClaim,
  ThreadSummary,
  WorkItem,
  WorkSourceError,
  WorkspaceResolution,
  WorkspaceRoleSelection,
  IssueOpenResult,
  ProjectOverview,
  ProjectIssueDetail,
  RecoveryActionRequest,
} from '@awos/protocol';
import type { ClientRequest, ServerResponseBody } from '@awos/protocol';
import { HarnessClient, resolveClientOptions, type ConnectionStatus } from '@/lib/client';
import { TranscriptFolder } from '@/lib/transcript';
import { foldArtifacts } from '@/lib/artifacts';
import { foldRuns } from '@/lib/runs';

/**
 * Long enough that a burst of typing is one write, short enough that you never wonder
 * whether it took.
 *
 * Saving per keystroke would put a socket round trip and a synchronous file write behind
 * every character; a save button is a thing you forget and then lose. Debounce plus a
 * visible state is the pair that has neither failure mode.
 */
const SAVE_DEBOUNCE_MS = 600;

function normalizeThreads(threads: readonly ThreadSummary[]): ThreadSummary[] {
  const byId = new Map<string, ThreadSummary>();
  for (const thread of threads) byId.set(thread.id, thread);
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export type PinnedContextSave = 'saved' | 'unsaved' | 'saving' | 'failed';

export type WorkspaceRoleSave = 'saved' | 'saving' | 'failed';

/**
 * The thread's pinned notes as the editor has them, tagged with the thread they belong to.
 *
 * The text on screen lives here rather than in the panel because the panel unmounts every
 * time another dock tab is selected, and words the user typed must not depend on which
 * tab happens to be showing. The tag is what lets a reply be told apart: text arriving for
 * the thread already open must not disturb what is being typed, text for a different
 * thread must replace it.
 */
export interface PinnedContext {
  threadId: string;
  text: string;
  save: PinnedContextSave;
}

/**
 * The workspace the open thread's directory resolves to, tagged with that directory.
 *
 * Tagged rather than bare because the panel must never show one project's settings under
 * another project's thread: a reply that arrives after a thread switch is dropped on the
 * tag, the same way pinned notes are.
 */
export interface WorkspaceView {
  cwd: string;
  resolution: WorkspaceResolution;
}

export interface ProjectOverviewView {
  cwd: string;
  overview: ProjectOverview | null;
  error: WorkSourceError | null;
  busy: boolean;
}

/**
 * The thread's work item and the last thing that went wrong reaching it.
 *
 * Both at once, and tagged with the thread: a refresh that fails still has the issue it
 * could not update, and blanking the panel over a dropped connection would take away the
 * thing the user was reading.
 */
export interface WorkView {
  threadId: string;
  item: WorkItem | null;
  error: WorkSourceError | null;
  /**
   * Everything kept about the item, including from threads this client never opened.
   *
   * Sent by the core rather than folded here, because the events behind it are in other
   * threads' logs — the one part of this panel the local event stream cannot answer.
   */
  retained: RetainedItem[];
  /** True while a request to GitHub is in flight, so the panel can say it is working. */
  busy: boolean;
}

/**
 * What the integration gate says about one agent's lane.
 *
 * Fetched rather than folded: the verdict depends on the lane's working tree as it stands
 * right now, which is a fact about the filesystem and not about the event log.
 */
export interface GateView {
  agent: AgentId;
  allowed: boolean;
  requirements: RequirementResult[];
  candidate: WorkingState;
}

/**
 * All harness state in one hook.
 *
 * The client is created once and kept in a ref; React state holds only what renders.
 * Events for the thread that isn't open are dropped rather than buffered — reopening a
 * thread refetches its full log from the core, which is cheap and always correct.
 */
export function useHarness() {
  const clientRef = useRef<HarnessClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new HarnessClient(resolveClientOptions());
  }
  const client = clientRef.current;

  const [status, setStatus] = useState<ConnectionStatus>('closed');
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [runtime, setRuntime] = useState<ThreadRuntimeState | null>(null);
  const [availability, setAvailability] = useState<AgentAvailability[]>([]);
  const [notice, setNotice] = useState<{ level: string; message: string } | null>(null);
  const [pinnedContext, setPinnedContext] = useState<PinnedContext | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [roleSelection, setRoleSelection] = useState<WorkspaceRoleSelection | null>(null);
  const [roleSelectionSave, setRoleSelectionSave] = useState<WorkspaceRoleSave>('saved');
  const [roleSelectionError, setRoleSelectionError] = useState<string | null>(null);
  const [work, setWork] = useState<WorkView | null>(null);
  const [gates, setGates] = useState<Partial<Record<AgentId, GateView>>>({});
  const [projectOverview, setProjectOverview] = useState<ProjectOverviewView | null>(null);

  // Read inside the push handler without making it a dependency, which would tear down
  // and rebuild the subscription on every thread switch.
  const activeThreadRef = useRef<string | null>(null);
  activeThreadRef.current = activeThreadId;

  const pinnedRef = useRef<PinnedContext | null>(null);
  pinnedRef.current = pinnedContext;

  /** The open thread's directory, for telling a stale workspace reply from a wanted one. */
  const activeCwdRef = useRef<string | null>(null);
  const projectOverviewCwdRef = useRef<string | null>(null);
  const projectOverviewRequestRef = useRef(0);
  const projectOverviewExplicitRefreshRef = useRef(false);
  const projectOverviewPushPendingRef = useRef(false);
  const refreshProjectOverviewRef = useRef<((cwd: string, refreshSource?: boolean) => Promise<void>) | null>(null);

  /**
   * Write out whatever the notes editor is holding that the core does not have yet.
   *
   * A failed write leaves the text exactly where it was and says so, rather than clearing
   * the pending flag — the next keystroke and the next reconnect both take another run at
   * it, so a dropped socket costs a warning rather than the user's words.
   */
  const flushPinnedContext = useCallback(async () => {
    const pending = pinnedRef.current;
    if (pending === null || pending.save === 'saved' || pending.save === 'saving') return;

    const { threadId, text } = pending;
    const update = (save: PinnedContextSave, guard: (prev: PinnedContext) => boolean) =>
      setPinnedContext((prev) =>
        prev !== null && prev.threadId === threadId && guard(prev) ? { ...prev, save } : prev,
      );

    update('saving', () => true);
    try {
      await client.request({ type: 'context.set', threadId, text });
    } catch {
      update('failed', () => true);
      setNotice({
        level: 'warn',
        message: 'Could not save the pinned notes. They are still here — the next edit retries.',
      });
      return;
    }
    // Keystrokes that landed while the write was in flight are still unsaved, so the
    // indicator must not claim otherwise.
    update('saved', (prev) => prev.text === text);
  }, [client]);

  /**
   * The write-behind timer lives here rather than in the panel so that closing the panel
   * neither cancels a pending write nor loses what it was going to carry.
   */
  useEffect(() => {
    if (pinnedContext === null || pinnedContext.save !== 'unsaved') return;
    const timer = window.setTimeout(() => void flushPinnedContext(), SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [pinnedContext, flushPinnedContext]);

  const editPinnedContext = useCallback((text: string) => {
    setPinnedContext((prev) => (prev === null ? prev : { ...prev, text, save: 'unsaved' }));
  }, []);

  useEffect(() => {
    const offStatus = client.onStatus((next) => {
      setStatus(next);
      // A status notification marks a new connection boundary. Until thread.open returns,
      // the previous runtime is not evidence about this core process, including when a
      // socket has just reopened and resync is still in flight.
      setRuntime(null);
    });

    const offPush = client.onPush((push) => {
      switch (push.type) {
        case 'event':
          if (push.event.threadId !== activeThreadRef.current) return;
          setEvents((prev) => [...prev, push.event]);
          return;
        case 'state':
          if (push.state.threadId === activeThreadRef.current) setRuntime(push.state);
          if (projectOverviewCwdRef.current !== null) {
            void refreshProjectOverviewRef.current?.(projectOverviewCwdRef.current);
          }
          return;
        case 'thread.updated':
          setThreads((prev) => normalizeThreads([...prev, push.thread]));
          if (projectOverviewCwdRef.current !== null) {
            void refreshProjectOverviewRef.current?.(projectOverviewCwdRef.current);
          }
          return;
        case 'thread.removed':
          setThreads((prev) => normalizeThreads(prev.filter((t) => t.id !== push.threadId)));
          if (activeThreadRef.current === push.threadId) {
            setActiveThreadId(null);
            setEvents([]);
            setRuntime(null);
            setPinnedContext(null);
            setWorkspace(null);
            setRoleSelection(null);
            setRoleSelectionSave('saved');
            setRoleSelectionError(null);
            setWork(null);
            setGates({});
            activeCwdRef.current = null;
            if (projectOverviewCwdRef.current !== null) {
              void refreshProjectOverviewRef.current?.(projectOverviewCwdRef.current);
            }
          }
          return;
        case 'notice':
          setNotice({ level: push.level, message: push.message });
          return;
      }
    });

    client.connect();
    return () => {
      offStatus();
      offPush();
    };
  }, [client]);

  /**
   * Re-read the declaration for a directory.
   *
   * Explicit rather than pushed, because the file is edited outside this app — in the
   * repository, by a person or by an agent — and the core does not watch it. Called when a
   * thread opens, and again whenever the user asks the panel to look now.
   */
  const refreshWorkspace = useCallback(
    async (cwd: string) => {
      const res = await client.request({ type: 'workspace.get', cwd }).catch(() => null);
      if (res?.type !== 'workspace') return;
      // Dropped rather than shown if the user has moved to a thread in another directory:
      // settings under the wrong project name are worse than a panel that lags a moment.
      if (activeCwdRef.current !== cwd) return;
      setWorkspace({ cwd, resolution: res.resolution });

      const role = await client.request({ type: 'workspace.role.get', cwd }).catch(() => null);
      if (activeCwdRef.current !== cwd) return;
      if (role?.type !== 'workspace.role') {
        setRoleSelection(null);
        setRoleSelectionError('Could not load the local role preference. Re-read the workspace to try again.');
        return;
      }
      setRoleSelection(role.selection);
      setRoleSelectionSave('saved');
      setRoleSelectionError(null);
    },
    [client],
  );

  const refreshProjectOverview = useCallback(
    async (cwd: string, refreshSource = false) => {
      if (!refreshSource && projectOverviewExplicitRefreshRef.current) {
        projectOverviewPushPendingRef.current = true;
        return;
      }
      if (refreshSource) projectOverviewExplicitRefreshRef.current = true;
      projectOverviewCwdRef.current = cwd;
      const requestId = ++projectOverviewRequestRef.current;
      setProjectOverview((previous) => ({
        cwd,
        overview: previous?.cwd === cwd ? previous.overview : null,
        error: previous?.cwd === cwd ? previous.error : null,
        busy: true,
      }));

      try {
        let refreshError: WorkSourceError | null = null;
        if (refreshSource) {
          const refreshed = await client.request({ type: 'catalog.refresh', cwd }).catch((error: unknown) => {
            refreshError = {
              kind: 'offline',
              message: error instanceof Error ? error.message : 'Could not refresh GitHub.',
              retryable: true,
            };
            return null;
          });
          if (refreshed?.type === 'catalog' && refreshed.error !== null) refreshError = refreshed.error;
        }

        const response = await client.request({
          type: 'project.overview.get',
          cwd,
        }).catch((error: unknown) => {
          refreshError ??= {
            kind: 'offline',
            message: error instanceof Error ? error.message : 'Could not read the project overview.',
            retryable: true,
          };
          return null;
        });
        if (requestId !== projectOverviewRequestRef.current || projectOverviewCwdRef.current !== cwd) return;

        if (response?.type !== 'project.overview') {
          setProjectOverview((previous) => ({
            cwd,
            overview: previous?.cwd === cwd ? previous.overview : null,
            error: refreshError,
            busy: false,
          }));
          return;
        }
        setProjectOverview({
          cwd,
          overview: response.overview,
          error: response.error ?? refreshError,
          busy: false,
        });
      } finally {
        if (refreshSource) {
          projectOverviewExplicitRefreshRef.current = false;
          if (projectOverviewPushPendingRef.current && projectOverviewCwdRef.current === cwd) {
            projectOverviewPushPendingRef.current = false;
            void refreshProjectOverviewRef.current?.(cwd);
          }
        }
      }
    },
    [client],
  );

  refreshProjectOverviewRef.current = refreshProjectOverview;

  const openProjectOverview = useCallback(
    (cwd: string) => refreshProjectOverview(cwd),
    [refreshProjectOverview],
  );

  const closeProjectOverview = useCallback((cwd: string) => {
    if (projectOverviewCwdRef.current !== cwd) return;
    projectOverviewCwdRef.current = null;
    projectOverviewExplicitRefreshRef.current = false;
    projectOverviewPushPendingRef.current = false;
    projectOverviewRequestRef.current += 1;
  }, []);

  const setWorkspaceRoleAt = useCallback(
    async (cwd: string | null, roleId: string | null) => {
      if (cwd === null) return;
      const isRelevant = () => activeCwdRef.current === cwd || projectOverviewCwdRef.current === cwd;
      if (!isRelevant()) return;
      setRoleSelectionSave('saving');
      setRoleSelectionError(null);
      try {
        const res = await client.request({ type: 'workspace.role.set', cwd, roleId });
        if (!isRelevant()) return;
        if (res.type !== 'workspace.role') {
          setRoleSelectionSave('failed');
          setRoleSelectionError('The harness returned an unexpected role-selection response.');
          return;
        }
        if (activeCwdRef.current === cwd) setRoleSelection(res.selection);
        setRoleSelectionSave('saved');
        void refreshProjectOverview(cwd);
      } catch (error) {
        if (!isRelevant()) return;
        setRoleSelectionSave('failed');
        setRoleSelectionError(error instanceof Error ? error.message : 'Could not save the local role preference.');
      }
    },
    [client, refreshProjectOverview],
  );

  const setWorkspaceRole = useCallback(
    (roleId: string | null) => setWorkspaceRoleAt(activeCwdRef.current, roleId),
    [setWorkspaceRoleAt],
  );

  const setProjectOverviewRole = useCallback(
    (cwd: string, roleId: string | null) => setWorkspaceRoleAt(cwd, roleId),
    [setWorkspaceRoleAt],
  );

  const openIssue = useCallback(
    async (cwd: string, number: number): Promise<IssueOpenResult> => {
      const response = await client.request({ type: 'issue.open', cwd, number });
      if (response.type !== 'issue.open') {
        throw new Error('The harness returned an unexpected issue-opening response.');
      }
      return response.result;
    },
    [client],
  );

  const openProjectIssueDetail = useCallback(
    async (cwd: string, number: number): Promise<{ detail: ProjectIssueDetail | null; error: WorkSourceError | null }> => {
      const response = await client.request({ type: 'project.issue.get', cwd, number });
      if (response.type !== 'project.issue') {
        throw new Error('The harness returned an unexpected issue-detail response.');
      }
      return { detail: response.detail, error: response.error };
    },
    [client],
  );

  /**
   * Every way of asking the core about the work item, in one place.
   *
   * They differ only in the request they send: each returns the item, the reason it could
   * not be read, or both, and each has to leave the panel showing something. Sharing the
   * reply handling is what keeps a failed refresh from behaving differently to a failed
   * attach for no reason the user could name.
   */
  const askAboutWork = useCallback(
    async (threadId: string, request: ClientRequest) => {
      setWork((prev) =>
        prev !== null && prev.threadId === threadId ? { ...prev, busy: true } : prev,
      );

      const res = await client.request(request).catch(
        (
          err: Error,
        ): {
          type: 'work';
          threadId: string;
          item: null;
          error: WorkSourceError;
          retained: RetainedItem[];
        } => ({
          type: 'work',
          threadId,
          item: null,
          // A socket that dropped is not a GitHub failure, but it lands in the same place
          // and the user's next move is the same one.
          error: { kind: 'offline', message: err.message, retryable: true },
          retained: [],
        }),
      );
      if (res.type !== 'work' || res.threadId !== threadId) return;
      if (activeThreadRef.current !== threadId) return;

      setWork((prev) => ({
        threadId,
        // A failure keeps whatever was on screen: the last known issue is still the best
        // answer available, and losing it would punish the user for a rate limit.
        item: res.error === null ? res.item : (res.item ?? prev?.item ?? null),
        error: res.error,
        retained: res.retained,
        busy: false,
      }));
    },
    [client],
  );

  const attachWorkItem = useCallback(
    async (reference: string) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      await askAboutWork(threadId, { type: 'work.attach', threadId, reference });
    },
    [askAboutWork],
  );

  const refreshWorkItem = useCallback(async () => {
    const threadId = activeThreadRef.current;
    if (threadId === null) return;
    await askAboutWork(threadId, { type: 'work.refresh', threadId });
  }, [askAboutWork]);

  const detachWorkItem = useCallback(async () => {
    const threadId = activeThreadRef.current;
    if (threadId === null) return;
    await askAboutWork(threadId, { type: 'work.detach', threadId });
  }, [askAboutWork]);

  /** Start a run: the same dispatch as a message, recorded as the work the issue asked for. */
  const startRun = useCallback(
    async (text: string, agent: AgentId) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      await client.request({ type: 'work.start', threadId, agent, text });
    },
    [client],
  );

  /**
   * State what a run achieved.
   *
   * Sending it again for the same run is a correction rather than an edit; the panel
   * re-reads the claim from the log like everything else, so nothing here has to know
   * that.
   */
  const closeRun = useCallback(
    async (runId: string, claim: RunClaim, statement: string) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      await client.request({ type: 'run.close', threadId, runId, claim, statement });
    },
    [client],
  );

  const recordEvidence = useCallback(
    async (runId: string, evidenceKind: EvidenceKind, ref: EvidenceRef, summary: string) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      await client.request({ type: 'evidence.record', threadId, runId, evidenceKind, ref, summary });
    },
    [client],
  );

  /**
   * Keep something against the work item.
   *
   * The reply carries the whole retained ledger, so the panel updates from the core's
   * answer rather than from a guess about what the core did with the request.
   */
  const retainContext = useCallback(
    async (retainedKind: RetainedKind, text: string, runId: string | null) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      await askAboutWork(threadId, { type: 'context.retain', threadId, retainedKind, text, runId });
    },
    [askAboutWork],
  );

  const amendRetained = useCallback(
    async (retainedId: string, patch: { selected?: boolean; retired?: boolean }) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      await askAboutWork(threadId, { type: 'context.amend', threadId, retainedId, ...patch });
    },
    [askAboutWork],
  );

  /**
   * Adopt the core's typed recovery reply without projecting a second local state
   * machine. Push events remain the durable update path; this makes the synchronous RPC
   * reply visible immediately when the panel is used against a quiet connection.
   */
  const handleRecoveryResponse = useCallback((threadId: string, response: ServerResponseBody) => {
    if (response.type === 'recovery.conflict') {
      setNotice({ level: 'warn', message: response.conflict.detail });
      return;
    }
    if (response.type !== 'recovery' || response.threadId !== threadId || response.cycle === null) return;
    const cycle = response.cycle;
    setRuntime((previous) => {
      if (previous?.threadId !== threadId) return previous;
      const recovery = [
        ...previous.recovery.filter((previousCycle) => previousCycle.cycleId !== cycle.cycleId),
        cycle,
      ];
      return { ...previous, recovery };
    });
  }, []);

  /** Ask the core to reserve the next recovery worker run at the displayed log head. */
  const startRecovery = useCallback(
    async (input: {
      transitionId: string;
      expectedAttempt: number;
      expectedHead: number;
      agent: AgentId;
      cycleId?: string;
    }) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      try {
        const response = await client.request({ type: 'recovery.start', threadId, ...input });
        handleRecoveryResponse(threadId, response);
      } catch (error) {
        setNotice({
          level: 'warn',
          message: error instanceof Error ? error.message : 'The recovery worker could not be started.',
        });
      }
    },
    [client, handleRecoveryResponse],
  );

  /** Submit one typed human recovery action; the core validates legality and freshness. */
  const applyRecoveryAction = useCallback(
    async (action: RecoveryActionRequest) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      try {
        const response = await client.request({ type: 'recovery.action', threadId, action });
        handleRecoveryResponse(threadId, response);
      } catch (error) {
        setNotice({
          level: 'warn',
          message: error instanceof Error ? error.message : 'The recovery action was not accepted by the core.',
        });
      }
    },
    [client, handleRecoveryResponse],
  );

  /**
   * Ask what the gate would decide about a lane right now.
   *
   * Explicit, because the answer moves whenever the lane does and nothing pushes that.
   * The panel asks when it opens and after a check reports back, which are the two moments
   * it can change without the user doing anything visible.
   */
  const readGate = useCallback(
    async (agent: AgentId) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      const res = await client.request({ type: 'gate.get', threadId, agent }).catch(() => null);
      if (res?.type !== 'gate' || res.threadId !== activeThreadRef.current) return;
      setGates((prev) => ({
        ...prev,
        [agent]: {
          agent,
          allowed: res.allowed,
          requirements: res.requirements,
          candidate: res.candidate,
        },
      }));
    },
    [client],
  );

  /** Run a named check where the agent's work is. Its result arrives as an event. */
  const runCheck = useCallback(
    async (agent: AgentId, name: string) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      await client.request({ type: 'verify.run', threadId, agent, name });
    },
    [client],
  );

  const refreshThreads = useCallback(async () => {
    const res = await client.request({ type: 'thread.list' });
    if (res.type === 'thread.list') setThreads(normalizeThreads(res.threads));
  }, [client]);

  const probeAgents = useCallback(async () => {
    const res = await client.request({ type: 'agents.probe' });
    if (res.type === 'agents.probe') {
      setAvailability(res.agents);
      if (projectOverviewCwdRef.current !== null) {
        void refreshProjectOverviewRef.current?.(projectOverviewCwdRef.current);
      }
    }
  }, [client]);

  const openThread = useCallback(
    async (threadId: string) => {
      // Pending notes go out before the editor moves on: the debounce timer does not
      // survive the switch, and on a reconnect this is what retries a write that failed
      // while the socket was down.
      await flushPinnedContext();

      const res = await client.request({ type: 'thread.open', threadId });
      if (res.type !== 'thread.opened') return;
      setActiveThreadId(threadId);
      // Claimed here rather than waiting for the next render, so the pinned-context reply
      // below can tell whether it is still wanted.
      const previousCwd = activeCwdRef.current;
      activeThreadRef.current = threadId;
      activeCwdRef.current = res.thread.cwd;
      // Blanked on a move to another directory only: reopening the same thread keeps the
      // panel populated rather than flashing its empty state.
      setWorkspace((prev) => (prev?.cwd === res.thread.cwd ? prev : null));
      if (previousCwd !== res.thread.cwd) {
        setRoleSelection(null);
        setRoleSelectionSave('saved');
        setRoleSelectionError(null);
      }
      // Lanes belong to a thread, so a verdict about another thread's lane is nonsense.
      setGates({});
      void refreshWorkspace(res.thread.cwd);
      // Read from the core rather than kept from the last thread: a work item belongs to
      // the thread, and showing the previous one for a moment would be showing the wrong
      // issue at the moment the user is deciding what to work on.
      setWork({ threadId, item: null, error: null, retained: [], busy: true });
      void askAboutWork(threadId, { type: 'work.get', threadId });
      setEvents(res.events);
      setRuntime(res.state);
      // Reopening the thread already on screen — a reconnect resync, a second click in
      // the sidebar — keeps the notes in place. Blanking them would read to the editor as
      // a thread change and throw away whatever is being typed.
      setPinnedContext((prev) => (prev?.threadId === threadId ? prev : null));
      setThreads((prev) => normalizeThreads([...prev, res.thread]));

      // Caught here so a failed notes fetch can't fail the open and take the transcript
      // down with it. Said out loud, because the panel would otherwise sit on a loading
      // state with no explanation and no prompt to try again.
      const context = await client
        .request({ type: 'context.get', threadId })
        .catch(() => null);
      if (activeThreadRef.current !== threadId) return;
      if (context?.type !== 'context') {
        setNotice({
          level: 'warn',
          message: 'Could not load the pinned notes for this thread. Reopen it to try again.',
        });
        return;
      }
      // Text from disk is adopted only when the editor has nothing of its own waiting —
      // that is what makes an edit made outside the app show up here, without a refetch
      // ever overwriting something half-typed.
      setPinnedContext((prev) =>
        prev !== null && prev.threadId === threadId && prev.save !== 'saved'
          ? prev
          : { threadId, text: context.text, save: 'saved' },
      );
    },
    [client, flushPinnedContext, refreshWorkspace, askAboutWork],
  );

  /**
   * On (re)connect, resync everything.
   *
   * Reopening the active thread is the part that matters. Events are pushed, so anything
   * that happened while the socket was down never arrived — without a refetch the
   * transcript silently stops matching reality, which is worse than showing an error.
   * `thread.open` returns the whole log, so one round trip restores correctness.
   */
  useEffect(() => {
    if (status !== 'open') return;
    void refreshThreads();
    void probeAgents();

    if (projectOverviewCwdRef.current !== null) {
      void refreshProjectOverviewRef.current?.(projectOverviewCwdRef.current);
    }

    const threadId = activeThreadRef.current;
    if (threadId === null) return;

    void openThread(threadId).catch(() => {
      // The thread can be gone if the core's data directory was cleared while we were
      // disconnected. Fall back to the empty state rather than showing a dead transcript.
      setActiveThreadId(null);
      setEvents([]);
      setRuntime(null);
      setPinnedContext(null);
      setWorkspace(null);
      setWork(null);
      activeCwdRef.current = null;
      setNotice({
        level: 'warn',
        message: 'That thread no longer exists on the harness.',
      });
    });
  }, [status, refreshThreads, probeAgents, openThread]);

  const createThread = useCallback(
    async (cwd: string, agent: AgentId) => {
      const res = await client.request({ type: 'thread.create', cwd, agent });
      if (res.type !== 'thread.created') return;
      setThreads((prev) => normalizeThreads([...prev, res.thread]));
      await openThread(res.thread.id);
    },
    [client, openThread],
  );

  const deleteThread = useCallback(
    async (threadId: string) => {
      await client.request({ type: 'thread.delete', threadId });
    },
    [client],
  );

  const send = useCallback(
    async (text: string, agent: AgentId) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      await client.request({ type: 'turn.send', threadId, agent, text });
    },
    [client],
  );

  const interrupt = useCallback(
    async (agent?: AgentId) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      await client.request({ type: 'turn.interrupt', threadId, agent });
    },
    [client],
  );

  const setParallel = useCallback(
    async (parallel: boolean) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      await client.request({ type: 'thread.setParallel', threadId, parallel });
    },
    [client],
  );

  const integrateLane = useCallback(
    async (agent: AgentId, override?: { reason: string }) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      await client.request({
        type: 'lane.integrate',
        threadId,
        agent,
        ...(override === undefined ? {} : { override }),
      });
    },
    [client],
  );

  const resolveApproval = useCallback(
    async (approvalId: string, optionId: string) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      await client.request({ type: 'approval.resolve', threadId, approvalId, optionId });
    },
    [client],
  );

  const setThreadAgent = useCallback(
    async (threadId: string, agent: AgentId) => {
      const response = await client.request({ type: 'thread.setAgent', threadId, agent });
      if (response.type !== 'ok') throw new Error('The harness returned an unexpected worker-selection response.');
    },
    [client],
  );

  const setAgent = useCallback(
    async (agent: AgentId) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      await setThreadAgent(threadId, agent);
    },
    [setThreadAgent],
  );

  const setPermissionMode = useCallback(
    async (mode: PermissionMode) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      await client.request({ type: 'thread.setPermissionMode', threadId, mode });
    },
    [client],
  );

  // The folder keeps the transcript fold's state between renders so a streaming delta
  // costs one event rather than the whole log. Run status is projected by the core from
  // the same log plus its exact live-runtime overlay, so an unfinished start does not
  // become a live worker merely because the UI reloaded it.
  const folderRef = useRef<TranscriptFolder | null>(null);
  if (folderRef.current === null) folderRef.current = new TranscriptFolder();
  const folder = folderRef.current;

  const transcript = useMemo(() => folder.fold(events), [folder, events]);
  const artifacts = useMemo(() => foldArtifacts(events), [events]);
  const runs = useMemo(() => foldRuns(events, runtime?.runStates ?? []), [events, runtime?.runStates]);
  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );

  return {
    status,
    threads,
    activeThread,
    activeThreadId,
    transcript,
    artifacts,
    runtime,
    availability,
    notice,
    pinnedContext,
    editPinnedContext,
    workspace,
    refreshWorkspace,
    roleSelection,
    roleSelectionSave,
    roleSelectionError,
    setWorkspaceRole,
    work,
    runs,
    attachWorkItem,
    refreshWorkItem,
    detachWorkItem,
    startRun,
    closeRun,
    gates,
    readGate,
    runCheck,
    recordEvidence,
    retainContext,
    amendRetained,
    startRecovery,
    applyRecoveryAction,
    dismissNotice: () => setNotice(null),
    openThread,
    createThread,
    deleteThread,
    send,
    interrupt,
    resolveApproval,
    setAgent,
    setThreadAgent,
    setPermissionMode,
    setParallel,
    integrateLane,
    projectOverview,
    openProjectOverview,
    closeProjectOverview,
    refreshProjectOverview,
    refreshProjectCatalog: (cwd: string) => refreshProjectOverview(cwd, true),
    setProjectOverviewRole,
    openIssue,
    openProjectIssueDetail,
  };
}

export type Harness = ReturnType<typeof useHarness>;
