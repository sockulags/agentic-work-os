import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Braces,
  Check,
  Copy,
  FileCode,
  FileText,
  ImageIcon,
  Table2,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { ArtifactKind } from '@awos/protocol';
import type { Artifact } from '@/lib/artifacts';
import { ArtifactView } from '@/components/artifact/ArtifactView';
import { useHarnessContext } from '@/state/HarnessContext';
import { cn, formatRelative } from '@/lib/utils';

const KIND_ICON: Readonly<Record<ArtifactKind, LucideIcon>> = {
  markdown: FileText,
  mermaid: Workflow,
  html: FileCode,
  json: Braces,
  csv: Table2,
  image: ImageIcon,
  text: FileText,
};

const KIND_LABEL: Readonly<Record<ArtifactKind, string>> = {
  markdown: 'Markdown',
  mermaid: 'Diagram',
  html: 'HTML',
  json: 'JSON',
  csv: 'Table',
  image: 'Image',
  text: 'Text',
};

/**
 * What the agents published, rendered instead of pasted.
 *
 * The whole point of the artifacts convention is that a diagram, a table or a report does
 * not have to survive as text in the chat log. So this panel is a viewer first: the list
 * is there to switch between artifacts, and everything else is the artifact itself.
 *
 * List and viewer sit side by side only once the dock is wide enough for both to be worth
 * reading; below that they stack, with the list capped so the artifact always keeps most
 * of the column. The breakpoint is a container query rather than a viewport one because
 * the dock's width is dragged by the user and has nothing to do with the window's.
 */
export function ArtifactsTab(): React.JSX.Element {
  const artifacts = useHarnessContext().artifacts;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Resolving the selection every render rather than syncing it in an effect: an artifact
  // can be deleted out from under the panel at any moment, and falling through to the
  // newest one is both the right answer and one that cannot go stale.
  const selected = artifacts.find((a) => a.id === selectedId) ?? artifacts[0] ?? null;

  if (selected === null) {
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground">
        Nothing published yet. Anything an agent writes into{' '}
        <code className="font-mono">.awos/artifacts/</code> in this thread&rsquo;s working
        directory shows up here &mdash; markdown, Mermaid diagrams, JSON, CSV, images and HTML.
      </p>
    );
  }

  return (
    <div className="@container h-full">
      <div className="flex h-full min-h-0 flex-col @lg:flex-row">
        <ul
          className={cn(
            'awos-scroll max-h-44 shrink-0 overflow-y-auto border-b border-border',
            '@lg:max-h-none @lg:w-48 @lg:border-b-0 @lg:border-r',
          )}
        >
          {artifacts.map((artifact) => (
            <ArtifactRow
              key={artifact.id}
              artifact={artifact}
              selected={artifact.id === selected.id}
              onSelect={() => setSelectedId(artifact.id)}
            />
          ))}
        </ul>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ArtifactHeader artifact={selected} />
          <div className="awos-scroll min-h-0 flex-1 overflow-y-auto">
            {/* Keyed so switching artifacts remounts the renderer: sort state in a table
                and a half-finished Mermaid render both belong to the artifact they came
                from, not to the panel. */}
            <ArtifactView key={selected.id} artifact={selected} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ArtifactRow({
  artifact,
  selected,
  onSelect,
}: {
  artifact: Artifact;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const Icon = KIND_ICON[artifact.kind];

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected}
        className={cn(
          'flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs transition-colors',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
          selected ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50',
        )}
      >
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-foreground">{artifact.title}</span>
          <span className="block truncate text-[10px] text-muted-foreground">
            {artifact.id} &middot; {formatRelative(artifact.updatedAt)}
          </span>
        </span>
      </button>
    </li>
  );
}

function ArtifactHeader({ artifact }: { artifact: Artifact }): React.JSX.Element {
  return (
    <div className="shrink-0 border-b border-border px-4 py-2">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {artifact.title}
        </h2>
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
          {KIND_LABEL[artifact.kind]}
        </span>
      </div>
      {/* Keyed so the copy confirmation belongs to the path it was given for: without
          this, clicking copy and then switching artifacts shows a tick against a path
          that never reached the clipboard. */}
      <PathAffordance key={artifact.id} path={artifact.path} />
    </div>
  );
}

/**
 * Where the artifact lives on disk.
 *
 * The path is shown rather than linked because the UI runs in a browser and cannot open a
 * local file; copying it is the affordance that actually leads somewhere, and seeing the
 * path at all is what makes the artifact something you can edit, diff and commit rather
 * than a view that exists only inside this app.
 */
function PathAffordance({ path }: { path: string }): React.JSX.Element {
  const [result, setResult] = useState<'idle' | 'copied' | 'failed'>('idle');

  // The clipboard is not always available: `navigator.clipboard` is undefined on an
  // insecure origin, which this UI is whenever it is opened over LAN rather than
  // localhost, and `writeText` rejects when the document has lost focus or the permission
  // was denied. Reporting a tick in those cases sends the user off to paste a path that
  // was never copied, so the failure is shown instead of swallowed.
  const copy = (): void => {
    const written = navigator.clipboard?.writeText(path);
    if (written === undefined) {
      setResult('failed');
      return;
    }
    void written.then(
      () => setResult('copied'),
      () => setResult('failed'),
    );
  };

  // The verdict is a flash, not a mode. Clearing it through an effect is what cancels the
  // timer when the dock closes or the artifact changes under it.
  useEffect(() => {
    if (result === 'idle') return;

    const timer = window.setTimeout(() => setResult('idle'), 1200);
    return () => window.clearTimeout(timer);
  }, [result]);

  return (
    <div className="mt-0.5 flex items-center gap-1">
      <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground" title={path}>
        {path}
      </code>
      <button
        type="button"
        onClick={copy}
        title={result === 'failed' ? 'Could not copy the path' : 'Copy path'}
        aria-label="Copy path"
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {result === 'copied' && <Check className="h-3 w-3 text-emerald-500" />}
        {result === 'failed' && <AlertTriangle className="h-3 w-3 text-destructive" />}
        {result === 'idle' && <Copy className="h-3 w-3" />}
      </button>
      <span aria-live="polite" className="sr-only">
        {result === 'copied' ? 'Path copied' : result === 'failed' ? 'Could not copy the path' : ''}
      </span>
    </div>
  );
}
