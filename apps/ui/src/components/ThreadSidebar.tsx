import { useState } from 'react';
import { Plus, Trash2, FolderOpen } from 'lucide-react';
import { Button } from './ui/button';
import { getAgentStyle } from './AgentBadge';
import { useHarnessContext } from '@/state/HarnessContext';
import { cn, formatRelative } from '@/lib/utils';
import { chooseProjectFolder, supportsNativeFolderPicker } from '@/lib/project-folder';

export function ThreadSidebar(): React.JSX.Element {
  const { threads, activeThreadId, openThread, createThread, deleteThread, availability } = useHarnessContext();
  const defaultAgent = availability[0]?.profileId ?? 'claude';
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Seeded from the last thread, since consecutive threads usually share a repo.
  const [cwd, setCwd] = useState(threads[0]?.cwd ?? '');

  return (
    <aside className="flex w-[var(--shell-sidebar-width)] shrink-0 flex-col border-r border-border bg-surface-rail">
      <div className="flex items-center justify-between px-3 py-[var(--density-shell-header-padding)]">
        <h1 className="text-sm font-semibold">Threads</h1>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setCreating((v) => !v)}
          title="New thread"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {creating && (
        <form
          className="flex flex-col gap-2 border-y border-border bg-surface-sunken px-3 py-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const trimmed = cwd.trim();
            if (trimmed === '') return;
            setCreateError(null);
            setSubmitting(true);
            try {
              await createThread(trimmed, defaultAgent);
              setCreating(false);
            } catch (error) {
              setCreateError(errorMessage(error));
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <label className="block text-xs text-muted-foreground">
            Working directory
            <div className="mt-1 flex gap-1.5">
              <input
                value={cwd}
                onChange={(e) => {
                  setCwd(e.target.value);
                  setCreateError(null);
                }}
                placeholder="C:\\Users\\you\\project"
                autoFocus
                className="awos-input min-w-0 flex-1 font-mono text-xs"
              />
              {supportsNativeFolderPicker() && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0 text-xs"
                  disabled={submitting}
                  onClick={async () => {
                    setCreateError(null);
                    try {
                      const selected = await chooseProjectFolder(cwd.trim() || undefined);
                      if (selected !== null) setCwd(selected);
                    } catch (error) {
                      setCreateError(errorMessage(error));
                    }
                  }}
                >
                  Browse…
                </Button>
              )}
            </div>
          </label>
          {createError && <p className="text-xs text-destructive">{createError}</p>}
          <div className="flex gap-1.5">
            <Button type="submit" size="sm" className="flex-1 text-xs" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-xs"
              disabled={submitting}
              onClick={() => {
                setCreateError(null);
                setCreating(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      <div className="awos-scroll flex-1 overflow-y-auto px-2 pb-2">
        {threads.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No threads yet.
          </p>
        ) : (
          threads.map((thread) => {
            const active = thread.id === activeThreadId;
            const style = getAgentStyle(thread.activeAgent);
            return (
              <div
                key={thread.id}
                className={cn(
                  'group relative mb-0.5 cursor-pointer rounded-md px-2 py-2 text-left transition-colors',
                  active ? 'bg-surface-selected' : 'hover:bg-surface-interactive/60',
                )}
                style={style.cssVars}
                onClick={() => void openThread(thread.id)}
              >
                <div className="flex items-center gap-1.5">
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', style.dot)} />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {thread.title}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1 pl-3 text-[10px] text-muted-foreground">
                  <FolderOpen className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">{basename(thread.cwd)}</span>
                  <span className="shrink-0">· {formatRelative(thread.updatedAt)}</span>
                </div>

                <button
                  type="button"
                  title="Delete thread"
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteThread(thread.id);
                  }}
                  className="awos-focus-ring absolute right-1 top-1.5 hidden rounded p-1 text-muted-foreground hover:bg-state-failed-surface hover:text-state-failed group-hover:block"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not create the thread.';
}

/** Handles both separators, since threads can be created from either platform. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
