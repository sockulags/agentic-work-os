import { useState } from 'react';
import { Plus, Trash2, FolderOpen } from 'lucide-react';
import type { AgentId, ThreadSummary } from '@awos/protocol';
import { Button } from './ui/button';
import { AGENT_STYLE } from './AgentBadge';
import { cn, formatRelative } from '@/lib/utils';
import { chooseProjectFolder, supportsNativeFolderPicker } from '@/lib/project-folder';

export function ThreadSidebar({
  threads,
  activeThreadId,
  onOpen,
  onCreate,
  onDelete,
}: {
  threads: ThreadSummary[];
  activeThreadId: string | null;
  onOpen: (id: string) => void;
  onCreate: (cwd: string, agent: AgentId) => Promise<void>;
  onDelete: (id: string) => void;
}): React.JSX.Element {
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Seeded from the last thread, since consecutive threads usually share a repo.
  const [cwd, setCwd] = useState(threads[0]?.cwd ?? '');

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card/30">
      <div className="flex items-center justify-between px-3 py-3">
        <h1 className="text-sm font-semibold">Threads</h1>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => setCreating((v) => !v)}
          title="New thread"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {creating && (
        <form
          className="space-y-2 border-y border-border bg-background/60 px-3 py-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const trimmed = cwd.trim();
            if (trimmed === '') return;
            setCreateError(null);
            setSubmitting(true);
            try {
              await onCreate(trimmed, 'claude');
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
                className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              {supportsNativeFolderPicker() && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-auto shrink-0 px-2 text-xs"
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
            <Button type="submit" size="sm" className="h-7 flex-1 text-xs" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
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
            const style = AGENT_STYLE[thread.activeAgent];
            return (
              <div
                key={thread.id}
                className={cn(
                  'group relative mb-0.5 cursor-pointer rounded-md px-2 py-2 text-left transition-colors',
                  active ? 'bg-accent' : 'hover:bg-accent/50',
                )}
                onClick={() => onOpen(thread.id)}
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
                    onDelete(thread.id);
                  }}
                  className="absolute right-1 top-1.5 hidden rounded p-1 text-muted-foreground hover:bg-destructive/20 hover:text-destructive group-hover:block"
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
