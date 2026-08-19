import type { ArtifactKind, HarnessEvent } from '@awos/protocol';

/**
 * Folds `artifact.updated` events into the set of artifacts that currently exist.
 *
 * The core never sends a list — it sends one event per write, and the log is append-only,
 * so "what is published right now" has to be derived rather than received. Doing it here
 * as a pure fold means the answer survives a reload for free: replaying `events.jsonl`
 * through this produces the same set the live socket did.
 *
 * Two rules do all the work. The latest event for an `artifactId` supersedes the previous
 * one, because the file has exactly one current content. And empty content is the
 * tombstone the core writes when the file is gone, which removes the artifact instead of
 * rendering an empty panel — see `packages/core/src/store/artifact-store.ts`.
 */

export interface Artifact {
  /** The file name inside `<cwd>/.awos/artifacts/`. Stable across rewrites. */
  id: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  /** Absolute path on disk, so the file behind the panel stays findable. */
  path: string;
  updatedAt: number;
}

export function foldArtifacts(events: readonly HarnessEvent[]): Artifact[] {
  const live = new Map<string, Artifact>();

  for (const event of events) {
    if (event.kind !== 'artifact.updated') continue;

    if (event.content === '') {
      live.delete(event.artifactId);
      continue;
    }

    live.set(event.artifactId, {
      id: event.artifactId,
      title: event.title,
      kind: event.artifactKind,
      content: event.content,
      path: event.path,
      updatedAt: event.updatedAt,
    });
  }

  // Newest first, matching the thread list: the artifact an agent just published is the
  // one worth looking at, and it should not be buried under everything published earlier.
  // Ties break on id so the order never depends on Map insertion history.
  return [...live.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
