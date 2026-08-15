import { describe, test, expect } from 'vitest';
import {
  parseUnifiedDiff,
  looksLikeUnifiedDiff,
  toSideBySideRows,
  intralineChange,
  countLines,
  type DiffLine,
} from './diff';

const GIT_PATCH = `diff --git a/src/auth.ts b/src/auth.ts
index 83db48f..bf269f4 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,5 +10,6 @@ export const config = {
 import { verify } from './jwt';
-export function authenticate(token: string) {
-  return verify(token);
+export function verifyToken(token: string) {
+  return verify(token, { clock: Date.now });
 }
+
`;

function line(
  kind: DiffLine['kind'],
  text: string,
  oldNumber: number | null,
  newNumber: number | null,
): DiffLine {
  return { kind, text, oldNumber, newNumber };
}

describe('parseUnifiedDiff — structure', () => {
  test('reads a git patch into one file with counts', () => {
    const parsed = parseUnifiedDiff(GIT_PATCH);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.path).toBe('src/auth.ts');
    expect(parsed.files[0]?.status).toBe('modified');
    expect(parsed.additions).toBe(3);
    expect(parsed.deletions).toBe(2);
  });

  test('groups lines under their hunk', () => {
    const parsed = parseUnifiedDiff(GIT_PATCH);
    expect(parsed.files[0]?.hunks).toHaveLength(1);
    expect(parsed.files[0]?.hunks[0]?.header).toContain('@@ -10,5 +10,6 @@');
  });

  test('strips the leading marker from content', () => {
    const parsed = parseUnifiedDiff(GIT_PATCH);
    const added = parsed.files[0]?.hunks[0]?.lines.filter((l) => l.kind === 'add') ?? [];
    expect(added[0]?.text).toBe('export function verifyToken(token: string) {');
  });

  test('headers never become content lines', () => {
    const lines = parseUnifiedDiff(GIT_PATCH).files[0]?.hunks[0]?.lines ?? [];
    // Otherwise every file would report one phantom addition and one phantom deletion.
    expect(lines.some((l) => l.text.startsWith('++') || l.text.startsWith('--'))).toBe(false);
  });

  test('index and mode metadata is dropped rather than rendered', () => {
    const lines = parseUnifiedDiff(GIT_PATCH).files[0]?.hunks[0]?.lines ?? [];
    expect(lines.some((l) => l.text.startsWith('index '))).toBe(false);
  });
});

describe('parseUnifiedDiff — line numbers', () => {
  test('numbers start from the hunk header, not from one', () => {
    const parsed = parseUnifiedDiff(GIT_PATCH);
    const lines = parsed.files[0]?.hunks[0]?.lines ?? [];
    const firstContext = lines.find((l) => l.kind === 'context');
    expect(firstContext?.oldNumber).toBe(10);
    expect(firstContext?.newNumber).toBe(10);
  });

  test('added lines have no old number and removed lines no new number', () => {
    const lines = parseUnifiedDiff(GIT_PATCH).files[0]?.hunks[0]?.lines ?? [];
    for (const l of lines) {
      if (l.kind === 'add') expect(l.oldNumber).toBeNull();
      if (l.kind === 'remove') expect(l.newNumber).toBeNull();
      if (l.kind === 'context') {
        expect(l.oldNumber).not.toBeNull();
        expect(l.newNumber).not.toBeNull();
      }
    }
  });

  test('the two sides advance independently', () => {
    const patch = `--- a/x
+++ b/x
@@ -5,3 +7,3 @@
 one
-two
+TWO
 three
`;
    const lines = parseUnifiedDiff(patch).files[0]?.hunks[0]?.lines ?? [];
    expect(lines.map((l) => [l.kind, l.oldNumber, l.newNumber])).toEqual([
      ['context', 5, 7],
      ['remove', 6, null],
      ['add', null, 8],
      ['context', 7, 9],
    ]);
  });

  test('keeps hunk content that resembles file headers', () => {
    const patch = `--- a/options.txt
+++ b/options.txt
@@ -10,3 +10,3 @@
 context before
--- option
+++ option
 context after
`;
    const parsed = parseUnifiedDiff(patch);
    const lines = parsed.files[0]?.hunks[0]?.lines ?? [];
    expect(parsed.additions).toBe(1);
    expect(parsed.deletions).toBe(1);
    expect(lines.map((l) => [l.kind, l.text, l.oldNumber, l.newNumber])).toEqual([
      ['context', 'context before', 10, 10],
      ['remove', '-- option', 11, null],
      ['add', '++ option', null, 11],
      ['context', 'context after', 12, 12],
    ]);
  });

  test('multiple hunks each restart from their own header', () => {
    const patch = `--- a/x
+++ b/x
@@ -1,2 +1,2 @@
-a
+A
@@ -50,2 +50,2 @@
-b
+B
`;
    const hunks = parseUnifiedDiff(patch).files[0]?.hunks ?? [];
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.oldStart).toBe(1);
    expect(hunks[1]?.oldStart).toBe(50);
    expect(hunks[1]?.lines[0]?.oldNumber).toBe(50);
  });

  test('a hunk header without counts still parses', () => {
    const parsed = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -3 +3 @@\n-a\n+b\n');
    expect(parsed.files[0]?.hunks[0]?.oldStart).toBe(3);
    expect(parsed.additions).toBe(1);
  });
});

describe('parseUnifiedDiff — file status', () => {
  test('detects an added file', () => {
    const patch = `diff --git a/fresh.ts b/fresh.ts
new file mode 100644
--- /dev/null
+++ b/fresh.ts
@@ -0,0 +1,2 @@
+line one
+line two
`;
    const file = parseUnifiedDiff(patch).files[0];
    expect(file?.status).toBe('added');
    expect(file?.path).toBe('fresh.ts');
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(0);
  });

  test('detects a deleted file', () => {
    const patch = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
`;
    const file = parseUnifiedDiff(patch).files[0];
    expect(file?.status).toBe('deleted');
    expect(file?.deletions).toBe(2);
  });

  test('detects a rename and keeps both paths', () => {
    const patch = `diff --git a/old/name.ts b/new/name.ts
similarity index 92%
rename from old/name.ts
rename to new/name.ts
`;
    const file = parseUnifiedDiff(patch).files[0];
    expect(file?.status).toBe('renamed');
    expect(file?.path).toBe('new/name.ts');
    expect(file?.oldPath).toBe('old/name.ts');
  });

  test('detects a binary file', () => {
    const patch = `diff --git a/logo.png b/logo.png
index 1234567..89abcde 100644
Binary files a/logo.png and b/logo.png differ
`;
    const file = parseUnifiedDiff(patch).files[0];
    expect(file?.status).toBe('binary');
    expect(file?.hunks).toHaveLength(0);
  });

  test('keeps a mode-only git diff as a modified status-only file', () => {
    const patch = `diff --git a/bin/tool b/bin/tool
old mode 100644
new mode 100755
`;
    const parsed = parseUnifiedDiff(patch);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      path: 'bin/tool',
      status: 'modified',
      hunks: [],
      additions: 0,
      deletions: 0,
    });
    expect(parseUnifiedDiff('diff --git a/noise b/noise\nnot a diff\n').files).toHaveLength(0);
  });
});

describe('parseUnifiedDiff — leniency', () => {
  test('separates multiple files', () => {
    const patch = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-one
+two
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-three
+four
`;
    const parsed = parseUnifiedDiff(patch);
    expect(parsed.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(2);
  });

  test('separates headerless multiple files after each hunk is complete', () => {
    const patch = `--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new

--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-x
+y`;
    const parsed = parseUnifiedDiff(patch);

    expect(parsed.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
    expect(parsed.files.map((file) => [file.additions, file.deletions])).toEqual([
      [1, 1],
      [1, 1],
    ]);
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(2);
  });

  test('handles a patch with no git header', () => {
    const parsed = parseUnifiedDiff('--- old.txt\n+++ new.txt\n@@ -1 +1 @@\n-before\n+after\n');
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.path).toBe('new.txt');
  });

  test('ignores the no-newline marker', () => {
    const parsed = parseUnifiedDiff(
      '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n',
    );
    const lines = parsed.files[0]?.hunks[0]?.lines ?? [];
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.text.startsWith('\\'))).toBe(false);
  });

  test('CRLF line endings parse the same as LF', () => {
    const parsed = parseUnifiedDiff(GIT_PATCH.replace(/\n/g, '\r\n'));
    expect(parsed.files).toHaveLength(1);
    expect(parsed.additions).toBe(3);
    const lines = parsed.files[0]?.hunks[0]?.lines ?? [];
    expect(lines.some((l) => l.text.endsWith('\r'))).toBe(false);
  });

  test('empty and garbage input yield no files rather than throwing', () => {
    expect(parseUnifiedDiff('').files).toHaveLength(0);
    expect(parseUnifiedDiff('\n\n').files).toHaveLength(0);
    expect(parseUnifiedDiff('not a diff at all\njust text').files).toHaveLength(0);
    expect(() => parseUnifiedDiff(' ')).not.toThrow();
  });

  test('countLines totals every hunk', () => {
    const file = parseUnifiedDiff(GIT_PATCH).files[0];
    expect(file).toBeDefined();
    expect(countLines(file!)).toBe(file!.hunks[0]?.lines.length);
  });
});

describe('toSideBySideRows', () => {
  test('pairs a removal with the addition that replaces it', () => {
    const rows = toSideBySideRows([
      line('remove', 'old', 1, null),
      line('add', 'new', null, 1),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.left?.text).toBe('old');
    expect(rows[0]?.right?.text).toBe('new');
  });

  test('a context line fills both columns', () => {
    const context = line('context', 'same', 1, 1);
    const rows = toSideBySideRows([context]);
    expect(rows[0]?.left).toBe(context);
    expect(rows[0]?.right).toBe(context);
  });

  test('surplus removals get empty right cells', () => {
    const rows = toSideBySideRows([
      line('remove', 'a', 1, null),
      line('remove', 'b', 2, null),
      line('add', 'A', null, 1),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.left?.text).toBe('b');
    expect(rows[1]?.right).toBeNull();
  });

  test('surplus additions get empty left cells', () => {
    const rows = toSideBySideRows([
      line('remove', 'a', 1, null),
      line('add', 'A', null, 1),
      line('add', 'B', null, 2),
    ]);
    expect(rows[1]?.left).toBeNull();
    expect(rows[1]?.right?.text).toBe('B');
  });

  test('a pure insertion never occupies the left column', () => {
    const rows = toSideBySideRows([line('add', 'new', null, 1)]);
    expect(rows[0]?.left).toBeNull();
    expect(rows[0]?.right?.text).toBe('new');
  });

  test('context between two change runs keeps them apart', () => {
    const rows = toSideBySideRows([
      line('remove', 'a', 1, null),
      line('context', 'mid', 2, 1),
      line('add', 'B', null, 2),
    ]);
    // Without the flush on context, 'a' and 'B' would be paired across the gap.
    expect(rows).toHaveLength(3);
    expect(rows[0]?.right).toBeNull();
    expect(rows[2]?.left).toBeNull();
  });

  test('an empty hunk yields no rows', () => {
    expect(toSideBySideRows([])).toEqual([]);
  });
});

describe('intralineChange', () => {
  test('finds the changed middle of a small edit', () => {
    const change = intralineChange('const a = 1;', 'const a = 2;');
    expect(change).not.toBeNull();
    expect('const a = 1;'.slice(...(change?.oldRange ?? [0, 0]))).toBe('1');
    expect('const a = 2;'.slice(...(change?.newRange ?? [0, 0]))).toBe('2');
  });

  test('handles an insertion with an empty old range', () => {
    const change = intralineChange('foo(a)', 'foo(a, b)');
    expect(change).not.toBeNull();
    const [start, end] = change?.oldRange ?? [0, 0];
    expect(start).toBe(end);
    expect('foo(a, b)'.slice(...(change?.newRange ?? [0, 0]))).toBe(', b');
  });

  test('returns null for identical lines', () => {
    expect(intralineChange('same', 'same')).toBeNull();
  });

  test('returns null when the lines are too different to be worth highlighting', () => {
    // A full rewrite highlighted end to end is noise; the row colour already says it.
    expect(intralineChange('completely different text', 'nothing alike whatsoever')).toBeNull();
  });

  test('handles an empty side', () => {
    expect(intralineChange('', '')).toBeNull();
    expect(() => intralineChange('', 'added')).not.toThrow();
  });

  test('does not overlap prefix and suffix on repeated characters', () => {
    const change = intralineChange('aaa', 'aaaa');
    expect(change).not.toBeNull();
    const [oldStart, oldEnd] = change?.oldRange ?? [0, 0];
    const [newStart, newEnd] = change?.newRange ?? [0, 0];
    // Ranges must stay valid, or slice() would silently produce nonsense.
    expect(oldEnd).toBeGreaterThanOrEqual(oldStart);
    expect(newEnd).toBeGreaterThanOrEqual(newStart);
  });
});

describe('looksLikeUnifiedDiff', () => {
  test('accepts a git patch', () => {
    expect(looksLikeUnifiedDiff(GIT_PATCH)).toBe(true);
  });

  test('accepts a headerless patch with proper markers', () => {
    expect(looksLikeUnifiedDiff('--- a.txt\n+++ b.txt\n@@ -1,2 +1,2 @@\n-x\n+y\n')).toBe(true);
  });

  test('rejects ordinary command output', () => {
    // False positives are worse than false negatives: colouring plain output red and
    // green invents meaning that is not there.
    expect(looksLikeUnifiedDiff('npm test\n\n> 42 passing\n')).toBe(false);
    expect(looksLikeUnifiedDiff('')).toBe(false);
    expect(looksLikeUnifiedDiff('+ some list item\n- another item')).toBe(false);
  });

  test('rejects hunk markers without file headers', () => {
    expect(looksLikeUnifiedDiff('@@ -1,2 +1,2 @@\n-x\n+y')).toBe(false);
  });

  test('rejects prose that merely mentions diff syntax', () => {
    expect(looksLikeUnifiedDiff('Run `git diff` and look for @@ markers.')).toBe(false);
  });
});
