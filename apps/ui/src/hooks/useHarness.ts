import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentAvailability,
  AgentId,
  HarnessEvent,
  PermissionMode,
  ThreadRuntimeState,
  ThreadSummary,
} from '@awos/protocol';
import { HarnessClient, resolveClientOptions, type ConnectionStatus } from '@/lib/client';
import { foldTranscript } from '@/lib/transcript';
import { foldArtifacts } from '@/lib/artifacts';

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

  // Read inside the push handler without making it a dependency, which would tear down
  // and rebuild the subscription on every thread switch.
  const activeThreadRef = useRef<string | null>(null);
  activeThreadRef.current = activeThreadId;

  useEffect(() => {
    const offStatus = client.onStatus(setStatus);

    const offPush = client.onPush((push) => {
      switch (push.type) {
        case 'event':
          if (push.event.threadId !== activeThreadRef.current) return;
          setEvents((prev) => [...prev, push.event]);
          return;
        case 'state':
          if (push.state.threadId !== activeThreadRef.current) return;
          setRuntime(push.state);
          return;
        case 'thread.updated':
          setThreads((prev) => {
            const next = prev.filter((t) => t.id !== push.thread.id);
            next.unshift(push.thread);
            return next.sort((a, b) => b.updatedAt - a.updatedAt);
          });
          return;
        case 'thread.removed':
          setThreads((prev) => prev.filter((t) => t.id !== push.threadId));
          if (activeThreadRef.current === push.threadId) {
            setActiveThreadId(null);
            setEvents([]);
            setRuntime(null);
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

  const refreshThreads = useCallback(async () => {
    const res = await client.request({ type: 'thread.list' });
    if (res.type === 'thread.list') setThreads(res.threads);
  }, [client]);

  const probeAgents = useCallback(async () => {
    const res = await client.request({ type: 'agents.probe' });
    if (res.type === 'agents.probe') setAvailability(res.agents);
  }, [client]);

  const openThread = useCallback(
    async (threadId: string) => {
      const res = await client.request({ type: 'thread.open', threadId });
      if (res.type !== 'thread.opened') return;
      setActiveThreadId(threadId);
      setEvents(res.events);
      setRuntime(res.state);
      setThreads((prev) => prev.map((t) => (t.id === threadId ? res.thread : t)));
    },
    [client],
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

    const threadId = activeThreadRef.current;
    if (threadId === null) return;

    void openThread(threadId).catch(() => {
      // The thread can be gone if the core's data directory was cleared while we were
      // disconnected. Fall back to the empty state rather than showing a dead transcript.
      setActiveThreadId(null);
      setEvents([]);
      setRuntime(null);
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
      setThreads((prev) => [res.thread, ...prev]);
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

  const interrupt = useCallback(async () => {
    const threadId = activeThreadRef.current;
    if (threadId === null) return;
    await client.request({ type: 'turn.interrupt', threadId });
  }, [client]);

  const resolveApproval = useCallback(
    async (approvalId: string, optionId: string) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      await client.request({ type: 'approval.resolve', threadId, approvalId, optionId });
    },
    [client],
  );

  const setAgent = useCallback(
    async (agent: AgentId) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      await client.request({ type: 'thread.setAgent', threadId, agent });
    },
    [client],
  );

  const setPermissionMode = useCallback(
    async (mode: PermissionMode) => {
      const threadId = activeThreadRef.current;
      if (threadId === null) return;
      await client.request({ type: 'thread.setPermissionMode', threadId, mode });
    },
    [client],
  );

  const transcript = useMemo(() => foldTranscript(events), [events]);
  const artifacts = useMemo(() => foldArtifacts(events), [events]);
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
    dismissNotice: () => setNotice(null),
    openThread,
    createThread,
    deleteThread,
    send,
    interrupt,
    resolveApproval,
    setAgent,
    setPermissionMode,
  };
}

export type Harness = ReturnType<typeof useHarness>;
