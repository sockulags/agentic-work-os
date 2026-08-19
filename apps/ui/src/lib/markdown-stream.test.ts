import { describe, test, expect } from 'vitest';
import { parseFenceInfo, prepareMarkdown } from './markdown-stream';

/**
 * Every string here is a snapshot of a message mid-flight. The rule under test is that
 * the structure the reader sees while the text streams is the structure they end up with
 * — an unterminated fence must already be a code block, so nothing reflows when the
 * closing marker finally arrives.
 */

/** What the reader ends up with once the agent closes the fence itself. */
function settled(markdown: string): string {
  return prepareMarkdown(markdown, false);
}

describe('prepareMarkdown — unterminated fences', () => {
  test('closes a fence the stream has not closed yet', () => {
    const output = prepareMarkdown('Here:\n```ts\nconst a = 1;', true);
    expect(output).toBe('Here:\n```ts\nconst a = 1;\n```\n');
  });

  test('leaves a balanced document untouched', () => {
    const balanced = 'Here:\n```ts\nconst a = 1;\n```\n\nDone.';
    expect(prepareMarkdown(balanced, true)).toBe(balanced);
    expect(settled(balanced)).toBe(balanced);
  });

  test('reaches the same block structure before and after the closing marker', () => {
    const partial = prepareMarkdown('```ts\nconst a = 1;\nconst b = 2;', true);
    const complete = settled('```ts\nconst a = 1;\nconst b = 2;\n```\n');
    expect(partial.trimEnd()).toBe(complete.trimEnd());
  });

  test('closes with the marker that opened, not a default one', () => {
    expect(prepareMarkdown('~~~~python\nx = 1', true)).toBe('~~~~python\nx = 1\n~~~~\n');
  });

  test('treats a shorter inner marker as code, not as the close', () => {
    const output = prepareMarkdown('````md\n```ts\nconst a = 1;\n```', true);
    expect(output).toBe('````md\n```ts\nconst a = 1;\n```\n````\n');
  });

  test('closes a fence nested in a list item', () => {
    const output = prepareMarkdown('- step one\n\n    ```sh\n    npm test', true);
    expect(output.endsWith('\n    ```\n')).toBe(true);
  });

  test('does not treat a marker carrying an info string as a close', () => {
    const output = prepareMarkdown('```ts\na\n```js\nb', true);
    expect(output).toBe('```ts\na\n```js\nb\n```\n');
  });

  test('closes an unterminated fence in settled text too', () => {
    // A turn can end mid-fence when the agent is interrupted; the last message is still
    // the one on screen, so it gets the same treatment.
    expect(settled('```ts\nconst a = 1;')).toBe('```ts\nconst a = 1;\n```\n');
  });
});

describe('prepareMarkdown — markers still being typed', () => {
  test('hides a half-typed opener while streaming', () => {
    expect(prepareMarkdown('Look:\n``', true)).toBe('Look:\n');
  });

  test('keeps a half-typed marker once the text has settled', () => {
    expect(settled('Look:\n``')).toBe('Look:\n``');
  });

  test('hides a half-typed closing marker', () => {
    const output = prepareMarkdown('```ts\nconst a = 1;\n``', true);
    expect(output).toBe('```ts\nconst a = 1;\n```\n');
  });

  test('keeps a marker of the other character inside a fence', () => {
    // Nothing about `~~` can close a backtick fence, so it is content, not a marker.
    expect(prepareMarkdown('```md\n~~', true)).toBe('```md\n~~\n```\n');
  });

  test('leaves inline code alone', () => {
    expect(prepareMarkdown('call `useHarness` first', true)).toBe('call `useHarness` first');
  });
});

describe('parseFenceInfo', () => {
  test('reads a bare filename from the info string', () => {
    expect(parseFenceInfo('ts', 'src/foo.ts')).toEqual({ lang: 'ts', filename: 'src/foo.ts' });
  });

  test('reads a quoted title', () => {
    expect(parseFenceInfo('ts', 'title="src/foo.ts"')).toEqual({
      lang: 'ts',
      filename: 'src/foo.ts',
    });
  });

  test('reads an unquoted filename key', () => {
    expect(parseFenceInfo('sh', 'filename=deploy.sh')).toEqual({
      lang: 'sh',
      filename: 'deploy.sh',
    });
  });

  test('ignores renderer directives that are not filenames', () => {
    expect(parseFenceInfo('ts', '{1,3-5}')).toEqual({ lang: 'ts', filename: null });
  });

  test('survives a fence with no info string at all', () => {
    expect(parseFenceInfo(null, null)).toEqual({ lang: null, filename: null });
  });
});
