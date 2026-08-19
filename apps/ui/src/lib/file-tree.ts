/**
 * Turning a parsed diff into a navigable file index.
 *
 * A flat list of paths is unreadable once a change spans more than a handful of files:
 * every row repeats the same leading directories, and in a dock that is only a few
 * hundred pixels wide those repeats eat the part of the path that actually identifies
 * the file. Grouping by directory buys that width back.
 *
 * Two rules shape the result. Diff order is preserved rather than sorted, because the
 * reviewer scrolls the diff in that order and a tree that disagrees with it turns every
 * jump into a search. And a directory with a single child directory is merged into one
 * row — `src/components/dock` instead of three nested rows holding one entry each —
 * since a ladder of one is indentation without information.
 */

import { type DiffFile } from './diff';

export interface FileTreeFileNode {
  kind: 'file';
  /** Position in `ParsedDiff.files`; the identity the panel keys and scrolls by. */
  index: number;
  /** Trailing path segment. The directories above it live on the ancestor nodes. */
  label: string;
  file: DiffFile;
}

export interface FileTreeDirectoryNode {
  kind: 'directory';
  /** Full path from the root, unique per node and stable across re-parses. */
  path: string;
  /** One or more segments, joined when a single-child chain was merged. */
  label: string;
  children: FileTreeNode[];
  fileCount: number;
  additions: number;
  deletions: number;
}

export type FileTreeNode = FileTreeFileNode | FileTreeDirectoryNode;

interface Entry {
  index: number;
  file: DiffFile;
  segments: string[];
}

/**
 * Split a diff path into segments.
 *
 * Diffs always use forward slashes, including on Windows, so there is no separator
 * detection to do. Empty segments are dropped so a leading slash or a doubled one cannot
 * produce a nameless directory row.
 */
function splitPath(path: string): string[] {
  const segments = path.split('/').filter((segment) => segment !== '');
  return segments.length === 0 ? [path] : segments;
}

export function buildFileTree(files: readonly DiffFile[]): FileTreeNode[] {
  const entries: Entry[] = files.map((file, index) => ({
    index,
    file,
    segments: splitPath(file.path),
  }));
  return group(entries, 0, '');
}

function group(entries: Entry[], depth: number, prefix: string): FileTreeNode[] {
  interface Bucket {
    segment: string;
    entries: Entry[];
  }

  // Slots hold insertion order; buckets hold membership. Keeping both means a directory
  // appears where its first file appeared, even when later files rejoin it.
  const slots: Array<Entry | Bucket> = [];
  const buckets = new Map<string, Bucket>();

  for (const entry of entries) {
    if (depth >= entry.segments.length - 1) {
      slots.push(entry);
      continue;
    }
    const segment = entry.segments[depth] ?? '';
    let bucket = buckets.get(segment);
    if (bucket === undefined) {
      bucket = { segment, entries: [] };
      buckets.set(segment, bucket);
      slots.push(bucket);
    }
    bucket.entries.push(entry);
  }

  return slots.map((slot) =>
    'file' in slot
      ? ({
          kind: 'file',
          index: slot.index,
          label: slot.segments[slot.segments.length - 1] ?? slot.file.path,
          file: slot.file,
        } satisfies FileTreeFileNode)
      : makeDirectory(slot.segment, slot.entries, depth, prefix),
  );
}

function makeDirectory(
  segment: string,
  entries: Entry[],
  depth: number,
  prefix: string,
): FileTreeDirectoryNode {
  const path = prefix === '' ? segment : `${prefix}/${segment}`;
  const children = group(entries, depth + 1, path);

  const node: FileTreeDirectoryNode = {
    kind: 'directory',
    path,
    label: segment,
    children,
    fileCount: entries.length,
    additions: entries.reduce((sum, entry) => sum + entry.file.additions, 0),
    deletions: entries.reduce((sum, entry) => sum + entry.file.deletions, 0),
  };

  const only = children.length === 1 ? children[0] : undefined;
  if (only !== undefined && only.kind === 'directory') {
    return { ...only, label: `${segment}/${only.label}` };
  }
  return node;
}

/** Every file node in render order, for keyboard navigation and jump targets. */
export function flattenFiles(nodes: readonly FileTreeNode[]): FileTreeFileNode[] {
  const out: FileTreeFileNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'file') out.push(node);
    else out.push(...flattenFiles(node.children));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Single-file patches
// ---------------------------------------------------------------------------

const MARKER: Record<'add' | 'remove' | 'context', string> = {
  add: '+',
  remove: '-',
  context: ' ',
};

/**
 * Re-serialize one parsed file into a standalone patch.
 *
 * The panel mounts a `DiffView` per file so that collapse state and scroll targets belong
 * to the panel rather than to the viewer, and `DiffView` takes patch text. Going back out
 * through the text form — instead of reaching into the viewer for a per-file entry point —
 * keeps `parseUnifiedDiff` the only thing that decides what a file is, so the tree, the
 * badge and the rendered diff cannot end up disagreeing about the file list.
 *
 * Hunk headers are re-emitted verbatim, which matters for more than fidelity: the parser
 * closes a hunk by counting down the header's line counts, so a rewritten header would
 * change where content stops being content.
 */
export function diffFileToPatch(file: DiffFile): string {
  const newPath = file.path;
  const oldPath = file.oldPath ?? file.path;
  const lines = [`diff --git a/${oldPath} b/${newPath}`];

  if (file.status === 'binary') {
    lines.push(`Binary files a/${oldPath} and b/${newPath} differ`);
    return `${lines.join('\n')}\n`;
  }

  if (file.status === 'renamed') {
    lines.push(`rename from ${oldPath}`, `rename to ${newPath}`);
  }

  // A modified file with no hunks is a metadata-only change, and the parser keeps such a
  // file only when it also saw a mode line. The numbers are placeholders — the original
  // modes are not part of the parsed form and nothing renders them — but without the
  // marker the file would drop out of its own patch and render as an empty card.
  if (file.status === 'modified' && file.hunks.length === 0) {
    lines.push('old mode 000000', 'new mode 000000');
  }

  lines.push(
    file.status === 'added' ? '--- /dev/null' : `--- a/${oldPath}`,
    file.status === 'deleted' ? '+++ /dev/null' : `+++ b/${newPath}`,
  );

  for (const hunk of file.hunks) {
    lines.push(hunk.header);
    for (const line of hunk.lines) {
      lines.push(`${MARKER[line.kind]}${line.text}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
