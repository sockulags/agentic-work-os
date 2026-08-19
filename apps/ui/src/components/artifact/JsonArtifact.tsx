import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { jsonTable } from '@/lib/artifact-table';
import { TableArtifact } from './TableArtifact';
import { cn } from '@/lib/utils';

type Parsed =
  | { ok: true; value: unknown; pretty: string }
  | { ok: false; message: string };

/**
 * JSON, as a grid when its shape allows and as formatted text otherwise.
 *
 * An array of objects is how an agent reports a result set, and a grid is the only useful
 * way to read one — but the raw view stays one click away, because the exact bytes matter
 * when the artifact is being used as a fixture or pasted somewhere else.
 *
 * Invalid JSON shows the parse error above the source instead of an empty panel. A
 * truncated write is a normal thing to catch mid-flight, and seeing where it broke is the
 * whole value of looking.
 */
export function JsonArtifact({ content }: { content: string }): React.JSX.Element {
  const parsed = useMemo<Parsed>(() => {
    try {
      const value: unknown = JSON.parse(content);
      return { ok: true, value, pretty: JSON.stringify(value, null, 2) };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }, [content]);

  const table = useMemo(() => (parsed.ok ? jsonTable(parsed.value) : null), [parsed]);
  const [showRaw, setShowRaw] = useState(false);

  if (!parsed.ok) {
    return (
      <div className="space-y-2 px-4 py-3">
        <p className="flex items-start gap-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>Not valid JSON: {parsed.message}</span>
        </p>
        <pre className="awos-scroll overflow-x-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-xs leading-relaxed">
          {content}
        </pre>
      </div>
    );
  }

  if (table !== null && !showRaw) {
    return (
      <div>
        <div className="px-4 pt-3">
          <ViewToggle raw={false} onToggle={() => setShowRaw(true)} />
        </div>
        <TableArtifact table={table} />
      </div>
    );
  }

  return (
    <div className="space-y-2 px-4 py-3">
      {table !== null && <ViewToggle raw onToggle={() => setShowRaw(false)} />}
      <pre className="awos-scroll overflow-x-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-xs leading-relaxed">
        {parsed.pretty}
      </pre>
    </div>
  );
}

function ViewToggle({
  raw,
  onToggle,
}: {
  raw: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors',
        'hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      )}
    >
      {raw ? 'Show table' : 'Show raw JSON'}
    </button>
  );
}
