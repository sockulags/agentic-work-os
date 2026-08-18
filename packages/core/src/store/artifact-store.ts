import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ArtifactKind, ArtifactUpdatedBody } from '@awos/protocol';
import { createLogger } from '../util/logger.js';

/**
 * Reading the artifacts directory: what counts as an artifact and what it becomes.
 *
 * Agents publish by writing a file into `<thread.cwd>/.awos/artifacts/`. That is the
 * entire protocol — no tool to register, no adapter to teach, identical for Claude and
 * Codex, and the result is a real file you can open, diff and commit. The cost is that
 * everything the event needs (kind, title, identity) has to be recovered from the file
 * itself, which is what this module does.
 *
 * It is deliberately pure and synchronous: given a directory it reads, and every failure
 * path returns null rather than throwing. A watcher firing on a file that was renamed
 * out from under it mid-read is normal, not exceptional.
 */

const log = createLogger('artifacts');

/** Where a thread's agents publish. Relative to the thread's working directory. */
export function artifactsDir(cwd: string): string {
  return join(cwd, '.awos', 'artifacts');
}

/**
 * Anything larger is skipped rather than truncated.
 *
 * Two reasons to have a ceiling at all: the content is inlined into the event, so it is
 * appended verbatim to `events.jsonl` on every write and shipped over the socket to every
 * connected UI; and a multi-megabyte payload is a build output or a dataset dump, not
 * something a human is going to read in a side panel. Truncating instead would produce a
 * half-rendered document that looks like a bug in the renderer.
 */
export const MAX_ARTIFACT_BYTES = 1024 * 1024;

const KIND_BY_EXT: Readonly<Record<string, ArtifactKind>> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mmd': 'mermaid',
  '.mermaid': 'mermaid',
  '.html': 'html',
  '.htm': 'html',
  '.json': 'json',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.svg': 'image',
};

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** Half-written files editors and tools leave behind while saving. */
const TEMP_EXTENSIONS = new Set(['.tmp', '.temp', '.part', '.crdownload', '.swp', '.swx']);

export function artifactKindFor(name: string): ArtifactKind {
  // Unknown extensions fall back to plain text: an agent that publishes `notes.log`
  // gets a readable panel rather than nothing at all.
  return KIND_BY_EXT[extname(name).toLowerCase()] ?? 'text';
}

/**
 * Whether a directory entry is something an agent meant to publish.
 *
 * The rules are all about writes in flight. A file appears in `fs.watch` the moment it is
 * created, so an editor's `.swp` companion or a `report.md.tmp` staging file would each
 * become an artifact of its own if we took every name at face value.
 */
export function isArtifactCandidate(name: string): boolean {
  if (name === '' || name.startsWith('.') || name.startsWith('#')) return false;
  if (name.endsWith('~')) return false;
  return !TEMP_EXTENSIONS.has(extname(name).toLowerCase());
}

/**
 * Candidate file names in the artifacts directory, or null when it could not be listed.
 *
 * A directory that does not exist yet is an answer — there are no artifacts. Any other
 * failure is not: the caller compares this list against what it has already published, so
 * reporting a transient EACCES, EMFILE or Windows sharing violation as "empty" would
 * retire every artifact it knows, permanently, on one bad readdir.
 */
export function listArtifactFiles(dir: string): string[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isArtifactCandidate(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    log.debug('artifacts directory unreadable', { dir, code });
    return null;
  }
}

/**
 * Read one file into the event body the dock renders, or null if it is not publishable.
 *
 * Images become `data:` URIs rather than a path, so that a consumer needs no second
 * channel to fetch bytes the core has already read — the event stays the whole story,
 * which is also what makes replay from `events.jsonl` work without the file surviving.
 */
export function readArtifact(dir: string, name: string): ArtifactUpdatedBody | null {
  if (!isArtifactCandidate(name)) return null;

  const path = join(dir, name);
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_ARTIFACT_BYTES) {
      log.warn('skipping oversize artifact', { name, size: stat.size, max: MAX_ARTIFACT_BYTES });
      return null;
    }

    const artifactKind = artifactKindFor(name);
    const content =
      artifactKind === 'image'
        ? toDataUri(name, readFileSync(path))
        : readFileSync(path, 'utf8');

    return {
      kind: 'artifact.updated',
      artifactId: name,
      title: deriveTitle(name, artifactKind, content),
      artifactKind,
      content,
      path,
      updatedAt: Math.round(stat.mtimeMs),
    };
  } catch (err) {
    // Renamed, deleted or locked between the watch event and the read. The next sweep
    // sees whatever the file system settled on.
    log.debug('artifact unreadable', { name, message: (err as Error).message });
    return null;
  }
}

/**
 * The event for an artifact whose file is gone.
 *
 * A deletion has to produce an event rather than being silently dropped, because every
 * consumer derives its state by folding the append-only log: a no-op would leave the last
 * `artifact.updated` as the newest word on that id, and the artifact would come back from
 * the dead on the next restart. Empty content is the tombstone.
 */
export function deletedArtifact(dir: string, name: string): ArtifactUpdatedBody {
  const artifactKind = artifactKindFor(name);
  return {
    kind: 'artifact.updated',
    artifactId: name,
    title: deriveTitle(name, artifactKind, ''),
    artifactKind,
    content: '',
    path: join(dir, name),
    updatedAt: Date.now(),
  };
}

/** Identity of an artifact's content, for suppressing re-emission of unchanged files. */
export function contentHash(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function toDataUri(name: string, bytes: Buffer): string {
  const mime = MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/**
 * A markdown artifact titles itself with its first heading; everything else falls back to
 * the file name. Agents write headings without being asked, and a title the author chose
 * beats one derived from a slug.
 */
function deriveTitle(name: string, kind: ArtifactKind, content: string): string {
  if (kind === 'markdown') {
    const heading = /^\s{0,3}#{1,6}[ \t]+(\S.*?)\s*#*\s*$/m.exec(content.slice(0, 4096));
    const text = heading?.[1]?.trim();
    if (text) return text.slice(0, 120);
  }

  const stem = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  if (stem === '') return name;
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}
