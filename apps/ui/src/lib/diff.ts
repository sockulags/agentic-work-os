/**
 * Unified-diff parsing into a structure a real viewer can render.
 *
 * The previous version produced a flat list of tagged lines, which is enough to colour
 * text and nothing more. A side-by-side view needs three things that only come from
 * actually reading the hunk headers: real line numbers on both sides, an explicit file
 * status (added / deleted / renamed / binary), and lines grouped per hunk so gaps in the
 * file are visible rather than silently concatenated.
 *
 * Deliberately lenient. Patches reach the UI from several places — Codex's
 * `turn/diff/updated`, a `git diff` an agent ran through Bash, whatever a tool printed —
 * and they do not all carry the same headers. A patch with no `diff --git` line, or one
 * that starts straight at a hunk, still renders. The parser never throws: unclassifiable
 * input degrades to context lines, because a slightly misformatted diff beats an error
 * where the changes should be.
 */

export type DiffLineKind = 'add' | 'remove' | 'context';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line number in the original file, or null for an added line. */
  oldNumber: number | null;
  /** Line number in the new file, or null for a removed line. */
  newNumber: number | null;
}

export interface DiffHunk {
  /** The raw `@@ … @@` header, including any trailing section heading git adds. */
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export type DiffFileStatus = 'added' | 'deleted' | 'renamed' | 'modified' | 'binary';

export interface DiffFile {
  path: string;
  /** Previous path, set only for a rename. */
  oldPath: string | null;
  status: DiffFileStatus;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface ParsedDiff {
  files: DiffFile[];
  additions: number;
  deletions: number;
}

const GIT_HEADER = /^diff --git\s+(?:"?a\/(.+?)"?)\s+(?:"?b\/(.+?)"?)\s*$/;
const OLD_FILE = /^---\s+(.*)$/;
const NEW_FILE = /^\+\+\+\s+(.*)$/;
const HUNK_HEADER = /^@@+\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;
const RENAME_TO = /^rename to\s+(.+)$/;
const RENAME_FROM = /^rename from\s+(.+)$/;

const DEV_NULL = '/dev/null';

/** Strip git's `a/` or `b/` prefix, surrounding quotes, and any trailing timestamp. */
function cleanPath(raw: string): string {
  let path = raw.trim().replace(/^"(.*)"$/, '$1');
  const tab = path.indexOf('\t');
  if (tab !== -1) path = path.slice(0, tab);
  path = path.trim();
  if (path === DEV_NULL) return path;
  return path.replace(/^[ab]\//, '');
}

function makeFile(path: string): DiffFile {
  return {
    path: path || 'unknown',
    oldPath: null,
    status: 'modified',
    hunks: [],
    additions: 0,
    deletions: 0,
  };
}

export function parseUnifiedDiff(patch: string): ParsedDiff {
  const files: DiffFile[] = [];
  const gitHeaderFiles = new WeakSet<DiffFile>();
  const modeMetadataFiles = new WeakSet<DiffFile>();

  // Assigned directly in the loop rather than through a helper: TypeScript's control
  // flow analysis doesn't track reassignment inside a closure, and would narrow these
  // to `never` after the first null check.
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  /** True when the path came from a `---` line and a `+++` may still correct it. */
  let provisionalPath = false;
  let oldLine = 0;
  let newLine = 0;
  let oldLinesRemaining = 0;
  let newLinesRemaining = 0;

  const startFile = (path: string): DiffFile => {
    const next = makeFile(path);
    files.push(next);
    hunk = null;
    return next;
  };

  // A patch that ends in a newline splits into a final empty element. That element is an
  // artifact of the terminator, not a line of the file — counting it would append a
  // phantom context row to the last hunk, complete with line numbers. Only the trailing
  // one is dropped; empty strings in the middle can be genuine blank context.
  const rawLines = patch.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

  for (const rawLine of rawLines) {
    const line = rawLine.replace(/\r$/, '');

    const gitMatch = GIT_HEADER.exec(line);
    if (gitMatch) {
      // Prefer the b/ path: for a rename it's the name the file ends up with.
      file = startFile(cleanPath(gitMatch[2] ?? gitMatch[1] ?? ''));
      gitHeaderFiles.add(file);
      provisionalPath = false;
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      if (file === null) file = startFile('');
      oldLine = Number.parseInt(hunkMatch[1] ?? '1', 10);
      newLine = Number.parseInt(hunkMatch[3] ?? '1', 10);
      oldLinesRemaining = Number.parseInt(hunkMatch[2] ?? '1', 10);
      newLinesRemaining = Number.parseInt(hunkMatch[4] ?? '1', 10);
      hunk = { header: line, oldStart: oldLine, newStart: newLine, lines: [] };
      file.hunks.push(hunk);
      if (oldLinesRemaining === 0 && newLinesRemaining === 0) hunk = null;
      continue;
    }

    // ---- Hunk content --------------------------------------------------------
    // Once inside a hunk, content takes precedence over file-level headers. A removed
    // `-- option` or added `++ option` therefore remains content rather than looking like
    // a `---`/`+++` file header.
    if (hunk !== null && file !== null) {
      // `\ No newline at end of file` annotates the previous line rather than being one.
      if (line.startsWith('\\')) continue;

      if (line.startsWith('+')) {
        hunk.lines.push({
          kind: 'add',
          text: line.slice(1),
          oldNumber: null,
          newNumber: newLine,
        });
        newLine += 1;
        newLinesRemaining = Math.max(0, newLinesRemaining - 1);
        file.additions += 1;
        if (oldLinesRemaining === 0 && newLinesRemaining === 0) hunk = null;
        continue;
      }

      if (line.startsWith('-')) {
        hunk.lines.push({
          kind: 'remove',
          text: line.slice(1),
          oldNumber: oldLine,
          newNumber: null,
        });
        oldLine += 1;
        oldLinesRemaining = Math.max(0, oldLinesRemaining - 1);
        file.deletions += 1;
        if (oldLinesRemaining === 0 && newLinesRemaining === 0) hunk = null;
        continue;
      }

      hunk.lines.push({
        kind: 'context',
        text: line.startsWith(' ') ? line.slice(1) : line,
        oldNumber: oldLine,
        newNumber: newLine,
      });
      oldLine += 1;
      newLine += 1;
      oldLinesRemaining = Math.max(0, oldLinesRemaining - 1);
      newLinesRemaining = Math.max(0, newLinesRemaining - 1);
      if (oldLinesRemaining === 0 && newLinesRemaining === 0) hunk = null;
      continue;
    }

    const oldMatch = OLD_FILE.exec(line);
    if (oldMatch) {
      const path = cleanPath(oldMatch[1] ?? '');
      if (file === null) {
        // No git header, so this starts a file. The `+++` that follows names it better.
        file = startFile(path === DEV_NULL ? '' : path);
        provisionalPath = true;
      } else if (
        hunk === null &&
        !gitHeaderFiles.has(file) &&
        (file.hunks.length > 0 || !provisionalPath)
      ) {
        // In a headerless multi-file patch, a completed file starts the next one.
        file = startFile(path === DEV_NULL ? '' : path);
        provisionalPath = true;
      }
      // `--- /dev/null` is how git spells "this file is new".
      if (path === DEV_NULL) file.status = 'added';
      continue;
    }

    const newMatch = NEW_FILE.exec(line);
    if (newMatch) {
      const path = cleanPath(newMatch[1] ?? '');
      if (file === null) {
        file = startFile(path);
      } else if (path === DEV_NULL) {
        file.status = 'deleted';
      } else if (provisionalPath || file.path === 'unknown' || file.path === '') {
        file.path = path;
      }
      provisionalPath = false;
      continue;
    }

    // ---- File-level metadata -------------------------------------------------
    if (file !== null) {
      if (line.startsWith('new file mode')) {
        file.status = 'added';
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        file.status = 'deleted';
        continue;
      }
      const renameTo = RENAME_TO.exec(line);
      if (renameTo) {
        file.status = 'renamed';
        file.path = cleanPath(renameTo[1] ?? file.path);
        continue;
      }
      const renameFrom = RENAME_FROM.exec(line);
      if (renameFrom) {
        file.status = 'renamed';
        file.oldPath = cleanPath(renameFrom[1] ?? '');
        continue;
      }
      if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
        file.status = 'binary';
        continue;
      }
      if (/^(old mode |new mode )/.test(line)) {
        modeMetadataFiles.add(file);
        continue;
      }
      // index/mode/similarity lines carry nothing the viewer shows.
      if (/^(index |similarity index |copy )/.test(line)) continue;
    }

    // Outside a hunk there is no line numbering to attach, so anything else is noise.
    if (hunk === null || file === null) continue;
  }

  // A file with neither hunks nor a status worth reporting contributed nothing.
  const meaningful = files.filter(
    (entry) =>
      entry.hunks.some((h) => h.lines.length > 0) ||
      entry.status === 'binary' ||
      entry.status === 'renamed' ||
      entry.status === 'deleted' ||
      entry.status === 'added' ||
      (entry.status === 'modified' &&
        gitHeaderFiles.has(entry) &&
        modeMetadataFiles.has(entry)),
  );

  return {
    files: meaningful,
    additions: meaningful.reduce((sum, f) => sum + f.additions, 0),
    deletions: meaningful.reduce((sum, f) => sum + f.deletions, 0),
  };
}

// ---------------------------------------------------------------------------
// Side-by-side pairing
// ---------------------------------------------------------------------------

export interface DiffRow {
  /** Original-side line, or null when this row is a pure addition. */
  left: DiffLine | null;
  /** New-side line, or null when this row is a pure deletion. */
  right: DiffLine | null;
}

/**
 * Turn a hunk's linear line list into aligned two-column rows.
 *
 * Within a run of removals immediately followed by additions, lines are paired by
 * position. That is what makes a one-character edit read as one changed row instead of
 * a deletion far above an addition. Any surplus on either side gets an empty cell.
 */
export function toSideBySideRows(lines: DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let removals: DiffLine[] = [];
  let additions: DiffLine[] = [];

  const flush = (): void => {
    const height = Math.max(removals.length, additions.length);
    for (let i = 0; i < height; i++) {
      rows.push({ left: removals[i] ?? null, right: additions[i] ?? null });
    }
    removals = [];
    additions = [];
  };

  for (const line of lines) {
    if (line.kind === 'remove') {
      removals.push(line);
      continue;
    }
    if (line.kind === 'add') {
      additions.push(line);
      continue;
    }
    flush();
    // A context line occupies both columns; it carries both numbers already.
    rows.push({ left: line, right: line });
  }

  flush();
  return rows;
}

// ---------------------------------------------------------------------------
// Intra-line highlighting
// ---------------------------------------------------------------------------

export interface IntralineChange {
  /** Character range that differs, as [start, end) on each side. */
  oldRange: [number, number];
  newRange: [number, number];
}

/**
 * Locate the differing middle of two paired lines by trimming the common prefix and
 * suffix.
 *
 * Returns null when the lines are identical, or when the change covers most of the
 * line. A near-total rewrite highlighted end to end is noise: at that point the row
 * background already says everything, and the highlight only adds visual weight.
 */
export function intralineChange(
  oldText: string,
  newText: string,
  similarityFloor = 0.3,
): IntralineChange | null {
  if (oldText === newText) return null;

  const maxPrefix = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix += 1;

  let suffix = 0;
  const maxSuffix = maxPrefix - prefix;
  while (
    suffix < maxSuffix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldEnd = oldText.length - suffix;
  const newEnd = newText.length - suffix;
  const changed = Math.max(oldEnd - prefix, newEnd - prefix);
  const longest = Math.max(oldText.length, newText.length);

  // Nothing shared worth pointing at.
  if (longest === 0) return null;
  if (1 - changed / longest < similarityFloor) return null;

  return { oldRange: [prefix, oldEnd], newRange: [prefix, newEnd] };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Whether a blob of tool output should be rendered as a diff.
 *
 * Conservative on purpose: a false positive turns ordinary output into misleading red
 * and green, which is worse than showing a real diff as plain text. Requires either a
 * git header or a proper `---`/`+++`/`@@` sequence.
 */
export function looksLikeUnifiedDiff(text: string): boolean {
  if (text.length === 0) return false;
  if (/^diff --git /m.test(text)) return true;
  const hasHunk = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(text);
  if (!hasHunk) return false;
  return /^--- /m.test(text) && /^\+\+\+ /m.test(text);
}

/** Total line count across a file's hunks, for render budgeting. */
export function countLines(file: DiffFile): number {
  return file.hunks.reduce((sum, h) => sum + h.lines.length, 0);
}
