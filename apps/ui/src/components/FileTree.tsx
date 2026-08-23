import { useMemo, useState } from 'react';
import {
  ChevronRight,
  FileMinus2,
  FilePen,
  FilePlus2,
  FileQuestion,
  FileSymlink,
  type LucideIcon,
} from 'lucide-react';
import type { DiffFile, DiffFileStatus } from '@/lib/diff';
import {
  buildFileTree,
  type FileTreeDirectoryNode,
  type FileTreeFileNode,
  type FileTreeNode,
} from '@/lib/file-tree';
import { cn } from '@/lib/utils';

/**
 * The index of a change set: which files it touches, how much of each, and a way to get
 * to one.
 *
 * Navigation only — it renders no diff content. That split is what lets the panel keep
 * the tree in view while the diff itself scrolls underneath, which is the whole reason
 * a long multi-file change becomes reviewable rather than a wall to scroll through.
 *
 * Directory rows collapse locally. Their open state is deliberately not persisted: a new
 * turn brings a different set of paths, so restoring which directories were open in the
 * previous change would be restoring an answer to a question nobody asked.
 */
export function FileTree({
  files,
  activeIndex,
  onSelect,
  className,
}: {
  files: readonly DiffFile[];
  /** Index into the parsed file list, or null when nothing has been jumped to yet. */
  activeIndex: number | null;
  onSelect: (index: number) => void;
  className?: string;
}): React.JSX.Element {
  const nodes = useMemo(() => buildFileTree(files), [files]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = (path: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };

  return (
    <div className={cn('awos-scroll overflow-auto', className)}>
      <ul role="tree" aria-label="Changed files" className="py-1">
        {nodes.map((node) => (
          <TreeNode
            key={nodeKey(node)}
            node={node}
            depth={0}
            collapsed={collapsed}
            onToggle={toggle}
            activeIndex={activeIndex}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  );
}

function nodeKey(node: FileTreeNode): string {
  return node.kind === 'file' ? `f:${node.index}` : `d:${node.path}`;
}

/** Indent per level, wide enough to read as nesting and narrow enough for a 280px dock. */
const INDENT_PX = 10;
const BASE_PADDING_PX = 6;

function TreeNode({
  node,
  depth,
  collapsed,
  onToggle,
  activeIndex,
  onSelect,
}: {
  node: FileTreeNode;
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  activeIndex: number | null;
  onSelect: (index: number) => void;
}): React.JSX.Element {
  if (node.kind === 'file') {
    return <FileRow node={node} depth={depth} active={node.index === activeIndex} onSelect={onSelect} />;
  }
  return (
    <DirectoryRow
      node={node}
      depth={depth}
      collapsed={collapsed}
      onToggle={onToggle}
      activeIndex={activeIndex}
      onSelect={onSelect}
    />
  );
}

function DirectoryRow({
  node,
  depth,
  collapsed,
  onToggle,
  activeIndex,
  onSelect,
}: {
  node: FileTreeDirectoryNode;
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  activeIndex: number | null;
  onSelect: (index: number) => void;
}): React.JSX.Element {
  const open = !collapsed.has(node.path);

  return (
    <li role="treeitem" aria-expanded={open}>
      <button
        type="button"
        onClick={() => onToggle(node.path)}
        style={{ paddingLeft: BASE_PADDING_PX + depth * INDENT_PX }}
        className="flex w-full items-center gap-1 py-0.5 pr-2 text-left text-xs text-muted-foreground hover:bg-surface-interactive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')}
          aria-hidden="true"
        />
        <span className="truncate font-mono">{node.label}</span>
        <span className="ml-auto shrink-0 tabular-nums">{node.fileCount}</span>
        <Counts additions={node.additions} deletions={node.deletions} />
      </button>

      {open && (
        <ul role="group">
          {node.children.map((child) => (
            <TreeNode
              key={nodeKey(child)}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              activeIndex={activeIndex}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

const STATUS_ICON: Record<DiffFileStatus, { Icon: LucideIcon; className: string; label: string }> = {
  added: { Icon: FilePlus2, className: 'text-diff-add', label: 'added' },
  deleted: { Icon: FileMinus2, className: 'text-diff-remove', label: 'deleted' },
  renamed: { Icon: FileSymlink, className: 'text-diff-modify', label: 'renamed' },
  binary: { Icon: FileQuestion, className: 'text-diff-context', label: 'binary' },
  modified: { Icon: FilePen, className: 'text-diff-modify', label: 'modified' },
};

function FileRow({
  node,
  depth,
  active,
  onSelect,
}: {
  node: FileTreeFileNode;
  depth: number;
  active: boolean;
  onSelect: (index: number) => void;
}): React.JSX.Element {
  const status = STATUS_ICON[node.file.status];
  // The status word is only shown to assistive tech: the row already carries an icon and
  // a colour, and spelling it out costs the width the path needs.
  const title =
    node.file.oldPath === null
      ? `${node.file.path} (${status.label})`
      : `${node.file.oldPath} → ${node.file.path} (${status.label})`;

  return (
    <li role="treeitem" aria-selected={active}>
      <button
        type="button"
        onClick={() => onSelect(node.index)}
        title={title}
        style={{ paddingLeft: BASE_PADDING_PX + depth * INDENT_PX }}
        className={cn(
          'flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-xs hover:bg-surface-interactive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
          active && 'bg-surface-selected text-foreground',
        )}
      >
        <status.Icon className={cn('h-3 w-3 shrink-0', status.className)} aria-hidden="true" />
        <span className="truncate font-mono">{node.label}</span>
        <span className="sr-only">{status.label}</span>
        <Counts additions={node.file.additions} deletions={node.file.deletions} className="ml-auto" />
      </button>
    </li>
  );
}

function Counts({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}): React.JSX.Element | null {
  if (additions === 0 && deletions === 0) return null;

  return (
    <span className={cn('flex shrink-0 gap-1 font-mono text-[10px] tabular-nums', className)}>
      {additions > 0 && <span className="text-diff-add">+{additions}</span>}
      {deletions > 0 && <span className="text-diff-remove">−{deletions}</span>}
    </span>
  );
}
