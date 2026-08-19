import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, type DiffFile } from './diff';
import {
  buildFileTree,
  diffFileToPatch,
  flattenFiles,
  type FileTreeDirectoryNode,
  type FileTreeNode,
} from './file-tree';

function directory(node: FileTreeNode | undefined): FileTreeDirectoryNode {
  if (node === undefined || node.kind !== 'directory') {
    throw new Error(`expected a directory node, got ${node?.kind ?? 'nothing'}`);
  }
  return node;
}

function file(path: string, overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    hunks: [],
    additions: 0,
    deletions: 0,
    ...overrides,
  };
}

const MULTI_FILE_PATCH = [
  'diff --git a/src/app/main.ts b/src/app/main.ts',
  '--- a/src/app/main.ts',
  '+++ b/src/app/main.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  'diff --git a/src/app/added.ts b/src/app/added.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/app/added.ts',
  '@@ -0,0 +1,2 @@',
  '+export const x = 1;',
  '+export const y = 2;',
  'diff --git a/docs/old.md b/docs/old.md',
  'deleted file mode 100644',
  '--- a/docs/old.md',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-gone',
  'diff --git a/docs/from.md b/docs/to.md',
  'similarity index 90%',
  'rename from docs/from.md',
  'rename to docs/to.md',
  '--- a/docs/from.md',
  '+++ b/docs/to.md',
  '@@ -1,1 +1,1 @@',
  '-old title',
  '+new title',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  '',
].join('\n');

describe('buildFileTree', () => {
  it('returns a bare file node for a path with no directory', () => {
    expect(buildFileTree([file('README.md')])).toEqual([
      { kind: 'file', index: 0, label: 'README.md', file: file('README.md') },
    ]);
  });

  it('groups files under their shared directory', () => {
    const nodes = buildFileTree([file('src/a.ts'), file('src/b.ts')]);

    expect(nodes).toHaveLength(1);
    const src = directory(nodes[0]);
    expect(src.path).toBe('src');
    expect(src.label).toBe('src');
    expect(src.children.map((child) => child.kind === 'file' && child.label)).toEqual([
      'a.ts',
      'b.ts',
    ]);
  });

  it('merges a chain of single-child directories into one row', () => {
    const nodes = buildFileTree([file('src/components/dock/Dock.tsx')]);

    const merged = directory(nodes[0]);
    expect(merged.label).toBe('src/components/dock');
    expect(merged.path).toBe('src/components/dock');
    expect(merged.children.map((child) => child.kind === 'file' && child.label)).toEqual([
      'Dock.tsx',
    ]);
  });

  it('stops merging where the chain branches', () => {
    const nodes = buildFileTree([file('src/lib/one.ts'), file('src/components/two.tsx')]);

    const src = directory(nodes[0]);
    expect(src.label).toBe('src');
    expect(src.children.map((child) => child.kind === 'directory' && child.label)).toEqual([
      'lib',
      'components',
    ]);
  });

  it('keeps diff order and rejoins a directory that reappears later', () => {
    const nodes = buildFileTree([file('src/a.ts'), file('docs/b.md'), file('src/c.ts')]);

    expect(nodes.map((node) => node.kind === 'directory' && node.label)).toEqual(['src', 'docs']);
    expect(directory(nodes[0]).children).toHaveLength(2);
  });

  it('sums additions and deletions onto every ancestor directory', () => {
    const nodes = buildFileTree([
      file('src/lib/a.ts', { additions: 3, deletions: 1 }),
      file('src/lib/b.ts', { additions: 4, deletions: 0 }),
    ]);

    const merged = directory(nodes[0]);
    expect(merged).toMatchObject({ label: 'src/lib', fileCount: 2, additions: 7, deletions: 1 });
  });

  it('places a file and a directory of the same name side by side', () => {
    const nodes = buildFileTree([file('src/index.ts'), file('src/index.ts/nested.ts')]);

    const src = directory(nodes[0]);
    expect(src.children.map((child) => child.kind)).toEqual(['file', 'directory']);
  });

  it('survives a path the parser could not classify', () => {
    expect(buildFileTree([file('unknown')])).toEqual([
      { kind: 'file', index: 0, label: 'unknown', file: file('unknown') },
    ]);
  });

  it('flattens back to diff order', () => {
    const parsed = parseUnifiedDiff(MULTI_FILE_PATCH);
    const flat = flattenFiles(buildFileTree(parsed.files));

    expect(flat.map((node) => node.index)).toEqual(parsed.files.map((_, index) => index));
    expect(flat.map((node) => node.file.path)).toEqual(parsed.files.map((f) => f.path));
  });
});

describe('diffFileToPatch', () => {
  it('round-trips every file of a multi-file patch', () => {
    const parsed = parseUnifiedDiff(MULTI_FILE_PATCH);
    expect(parsed.files).toHaveLength(5);

    for (const original of parsed.files) {
      const reparsed = parseUnifiedDiff(diffFileToPatch(original));
      expect(reparsed.files).toHaveLength(1);
      expect(reparsed.files[0]).toEqual(original);
    }
  });

  it('keeps a metadata-only change from vanishing into an empty patch', () => {
    const parsed = parseUnifiedDiff(
      ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755', ''].join('\n'),
    );
    expect(parsed.files).toHaveLength(1);

    const reparsed = parseUnifiedDiff(diffFileToPatch(parsed.files[0]!));
    expect(reparsed.files).toEqual(parsed.files);
  });

  it('preserves content that would otherwise look like a file header', () => {
    const patch = [
      'diff --git a/opts.txt b/opts.txt',
      '--- a/opts.txt',
      '+++ b/opts.txt',
      '@@ -1,1 +1,1 @@',
      '--- legacy flag',
      '+++ new flag',
      '',
    ].join('\n');

    const original = parseUnifiedDiff(patch).files[0]!;
    expect(parseUnifiedDiff(diffFileToPatch(original)).files[0]).toEqual(original);
  });

  it('re-emits the hunk header verbatim so line numbering is unchanged', () => {
    const patch = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -40,2 +40,2 @@ function outer() {',
      '-a',
      '+b',
      '',
    ].join('\n');

    expect(diffFileToPatch(parseUnifiedDiff(patch).files[0]!)).toContain(
      '@@ -40,2 +40,2 @@ function outer() {',
    );
  });
});
