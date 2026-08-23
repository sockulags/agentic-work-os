import { useMemo, useState } from 'react';
import { ChevronRight, Columns2, AlignLeft, FilePlus2, FileMinus2, FilePen, FileSymlink, FileQuestion } from 'lucide-react';
import {
  countLines,
  intralineChange,
  parseUnifiedDiff,
  toSideBySideRows,
  type DiffFile,
  type DiffFileStatus,
  type DiffHunk,
  type DiffLine,
  type DiffRow,
} from '@/lib/diff';
import { cn } from '@/lib/utils';

export type DiffViewMode = 'split' | 'unified';

/** Lines rendered per file before the "show all" affordance appears. */
const DEFAULT_LINE_BUDGET = 500;

/**
 * A real diff viewer: split or unified, with line numbers from the hunk headers,
 * per-file status, and intra-line highlighting on paired changes.
 *
 * Colour never carries meaning alone. Every changed row also has a `+`/`-` gutter
 * marker, and in split view a missing counterpart shows as a visibly empty cell, so the
 * diff is still readable without colour perception.
 */
export function DiffView({
  patch,
  defaultOpen = true,
  defaultMode = 'split',
  lineBudget = DEFAULT_LINE_BUDGET,
}: {
  patch: string;
  defaultOpen?: boolean;
  defaultMode?: DiffViewMode;
  lineBudget?: number;
}): React.JSX.Element | null {
  const [mode, setMode] = useState<DiffViewMode>(defaultMode);
  const parsed = useMemo(() => parseUnifiedDiff(patch), [patch]);

  if (parsed.files.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-end">
        <ViewModeToggle mode={mode} onChange={setMode} />
      </div>

      {parsed.files.map((file, index) => (
        <DiffFileBlock
          key={`${file.path}:${index}`}
          file={file}
          mode={mode}
          // Open everything for a small change; collapse when there is a lot to scan.
          defaultOpen={defaultOpen && parsed.files.length <= 3}
          lineBudget={lineBudget}
        />
      ))}
    </div>
  );
}

function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: DiffViewMode;
  onChange: (mode: DiffViewMode) => void;
}): React.JSX.Element {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border" role="group">
      {(
        [
          { value: 'split', label: 'Split', Icon: Columns2 },
          { value: 'unified', label: 'Unified', Icon: AlignLeft },
        ] as const
      ).map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          aria-pressed={mode === value}
          className={cn(
            'awos-focus-ring flex items-center gap-1 px-2 py-1 text-[11px] transition-colors duration-[var(--motion-fast)]',
            mode === value
              ? 'bg-surface-selected text-foreground'
              : 'text-muted-foreground hover:bg-surface-interactive',
          )}
        >
          <Icon className="h-3 w-3" />
          {label}
        </button>
      ))}
    </div>
  );
}

const STATUS_META: Record<
  DiffFileStatus,
  { label: string; Icon: typeof FilePen; className: string }
> = {
  added: { label: 'added', Icon: FilePlus2, className: 'text-diff-add' },
  deleted: { label: 'deleted', Icon: FileMinus2, className: 'text-diff-remove' },
  renamed: { label: 'renamed', Icon: FileSymlink, className: 'text-diff-modify' },
  binary: { label: 'binary', Icon: FileQuestion, className: 'text-diff-context' },
  modified: { label: 'modified', Icon: FilePen, className: 'text-diff-modify' },
};

function DiffFileBlock({
  file,
  mode,
  defaultOpen,
  lineBudget,
}: {
  file: DiffFile;
  mode: DiffViewMode;
  defaultOpen: boolean;
  lineBudget: number;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const [showAll, setShowAll] = useState(false);

  const total = countLines(file);
  const overBudget = !showAll && total > lineBudget;
  const status = STATUS_META[file.status];

  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface-raised">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${file.path}, ${status.label}, ${file.additions} additions, ${file.deletions} deletions`}
        className="awos-focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/40"
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <status.Icon className={cn('h-3.5 w-3.5 shrink-0', status.className)} />

        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {file.oldPath && (
            <>
              <code className="truncate font-mono text-xs text-muted-foreground line-through">
                {file.oldPath}
              </code>
              <span className="shrink-0 text-muted-foreground">→</span>
            </>
          )}
          <code className="truncate font-mono text-xs">{file.path}</code>
        </span>

        <span className={cn('shrink-0 text-[10px] uppercase tracking-wide', status.className)}>
          {status.label}
        </span>
        {file.additions > 0 && (
          <span className="shrink-0 font-mono text-[11px] text-diff-add">
            +{file.additions}
          </span>
        )}
        {file.deletions > 0 && (
          <span className="shrink-0 font-mono text-[11px] text-diff-remove">−{file.deletions}</span>
        )}
      </button>

      {open && (
        <div className="awos-scroll max-h-[36rem] overflow-auto border-t border-border">
          {file.status === 'binary' ? (
            <p className="px-3 py-2 text-xs italic text-muted-foreground">
              Binary file — no textual diff available.
            </p>
          ) : file.hunks.length === 0 ? (
            <p className="px-3 py-2 text-xs italic text-muted-foreground">
              No content changes; {status.label} only.
            </p>
          ) : (
            <FileBody file={file} mode={mode} limit={overBudget ? lineBudget : Infinity} />
          )}

          {overBudget && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-full border-t border-border px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
            >
              Show {total - lineBudget} more lines
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Renders hunks in order, stopping once the render budget is spent. */
function FileBody({
  file,
  mode,
  limit,
}: {
  file: DiffFile;
  mode: DiffViewMode;
  limit: number;
}): React.JSX.Element {
  let remaining = limit;
  const rendered: React.JSX.Element[] = [];

  for (const [index, hunk] of file.hunks.entries()) {
    if (remaining <= 0) break;
    const lines = hunk.lines.slice(0, remaining);
    remaining -= lines.length;
    const clipped: DiffHunk = { ...hunk, lines };
    rendered.push(
      mode === 'split' ? (
        <SplitHunk key={index} hunk={clipped} />
      ) : (
        <UnifiedHunk key={index} hunk={clipped} />
      ),
    );
  }

  return <>{rendered}</>;
}

function HunkHeader({ header, columns }: { header: string; columns: number }): React.JSX.Element {
  return (
    <tr className="bg-diff-context-surface">
      <td
        colSpan={columns}
        className="px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
      >
        {header}
      </td>
    </tr>
  );
}

const NUMBER_CELL = 'w-10 select-none px-1 text-right align-top text-muted-foreground/60';
const MARKER_CELL = 'w-4 select-none px-0.5 text-center align-top';

function SplitHunk({ hunk }: { hunk: DiffHunk }): React.JSX.Element {
  const rows = useMemo(() => toSideBySideRows(hunk.lines), [hunk.lines]);

  return (
    <table className="w-full table-fixed border-collapse font-mono text-[11px] leading-relaxed">
      <colgroup>
        <col className="w-10" />
        <col className="w-4" />
        <col />
        <col className="w-10" />
        <col className="w-4" />
        <col />
      </colgroup>
      <tbody>
        <HunkHeader header={hunk.header} columns={6} />
        {rows.map((row, index) => (
          <SplitRow key={index} row={row} />
        ))}
      </tbody>
    </table>
  );
}

function SplitRow({ row }: { row: DiffRow }): React.JSX.Element {
  const { left, right } = row;
  const isContext = left !== null && right !== null && left === right;

  // Only a genuine replacement pair gets character-level highlighting.
  const intraline =
    !isContext && left !== null && right !== null
      ? intralineChange(left.text, right.text)
      : null;

  return (
    <tr>
      <SideCells
        line={left}
        side="old"
        highlight={intraline?.oldRange ?? null}
        isContext={isContext}
      />
      <SideCells
        line={right}
        side="new"
        highlight={intraline?.newRange ?? null}
        isContext={isContext}
      />
    </tr>
  );
}

function SideCells({
  line,
  side,
  highlight,
  isContext,
}: {
  line: DiffLine | null;
  side: 'old' | 'new';
  highlight: [number, number] | null;
  isContext: boolean;
}): React.JSX.Element {
  if (line === null) {
    // An empty counterpart is what makes an unbalanced change readable at a glance.
    return (
      <>
        <td className={cn(NUMBER_CELL, 'bg-diff-context-surface')} />
        <td className={cn(MARKER_CELL, 'bg-diff-context-surface')} />
        <td className="bg-diff-context-surface" />
      </>
    );
  }

  const tone = isContext
    ? ''
    : side === 'old'
      ? 'bg-diff-remove-surface text-diff-remove'
      : 'bg-diff-add-surface text-diff-add';

  const marker = isContext ? '' : side === 'old' ? '−' : '+';
  const number = side === 'old' ? line.oldNumber : line.newNumber;

  return (
    <>
      <td className={cn(NUMBER_CELL, tone)}>{number ?? ''}</td>
      <td className={cn(MARKER_CELL, tone)} aria-hidden="true">
        {marker}
      </td>
      <td className={cn('whitespace-pre-wrap px-1 align-top', tone)}>
        <LineText text={line.text} highlight={highlight} side={side} />
      </td>
    </>
  );
}

function UnifiedHunk({ hunk }: { hunk: DiffHunk }): React.JSX.Element {
  return (
    <table className="w-full border-collapse font-mono text-[11px] leading-relaxed">
      <tbody>
        <HunkHeader header={hunk.header} columns={4} />
        {hunk.lines.map((line, index) => (
          <UnifiedRow key={index} line={line} />
        ))}
      </tbody>
    </table>
  );
}

const UNIFIED_TONE: Record<DiffLine['kind'], { row: string; marker: string }> = {
  add: { row: 'bg-diff-add-surface text-diff-add', marker: '+' },
  remove: { row: 'bg-diff-remove-surface text-diff-remove', marker: '−' },
  context: { row: 'bg-diff-context-surface text-diff-context', marker: ' ' },
};

function UnifiedRow({ line }: { line: DiffLine }): React.JSX.Element {
  const tone = UNIFIED_TONE[line.kind];
  return (
    <tr className={tone.row}>
      <td className={NUMBER_CELL}>{line.oldNumber ?? ''}</td>
      <td className={NUMBER_CELL}>{line.newNumber ?? ''}</td>
      <td className={MARKER_CELL} aria-hidden="true">
        {tone.marker}
      </td>
      <td className="whitespace-pre-wrap px-1 pr-3 align-top">
        {line.text || ' '}
      </td>
    </tr>
  );
}

/** Splits a line so the changed middle can be emphasised against its unchanged ends. */
function LineText({
  text,
  highlight,
  side,
}: {
  text: string;
  highlight: [number, number] | null;
  side: 'old' | 'new';
}): React.JSX.Element {
  if (highlight === null) return <>{text || ' '}</>;

  const [start, end] = highlight;
  if (start >= end) return <>{text || ' '}</>;

  return (
    <>
      {text.slice(0, start)}
      <mark
        className={cn(
          'rounded-[2px] bg-transparent px-0 text-inherit',
          side === 'old' ? 'bg-diff-remove-highlight' : 'bg-diff-add-highlight',
        )}
      >
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}
