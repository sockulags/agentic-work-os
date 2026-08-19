/**
 * Makes a half-received markdown document safe to parse.
 *
 * Agent messages render while they stream, so the parser sees the document mid-sentence
 * on every delta. The expensive case is the code fence: until its closing marker arrives
 * the parser reads everything after the opener as ordinary paragraphs, and the instant it
 * lands that whole tail becomes one code block — a page of text reflows out from under
 * whoever is reading it. Closing the fence virtually makes the block a block from its
 * first character, so the real closing marker changes nothing on screen.
 *
 * Kept apart from the component because this is the part that has to be right, and it is
 * far easier to be sure of it against a list of half-written strings than against a DOM.
 */

/**
 * Leading whitespace is matched loosely rather than the 0–3 spaces CommonMark allows at
 * the top level: a fence nested in a list item is indented past that, and missing one of
 * those is the exact reflow this module exists to prevent. The cost is a line inside an
 * indented code block that consists only of backticks, which agents effectively never
 * write.
 */
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/** A fence marker still being typed — one or two markers with nothing after them. */
const PARTIAL_FENCE = /^\s*(?:`{1,2}|~{1,2})$/;

export function prepareMarkdown(markdown: string, streaming: boolean): string {
  let text = markdown;

  if (streaming) {
    // The opener arrives one delta at a time, so for a beat the tail is a stray backtick
    // or two. Rendering those literally makes punctuation flash in and out of the text.
    const lastBreak = text.lastIndexOf('\n');
    const lastLine = text.slice(lastBreak + 1);
    if (lastLine.length > 0 && PARTIAL_FENCE.test(lastLine) && !insideFence(text.slice(0, lastBreak + 1))) {
      text = text.slice(0, lastBreak + 1);
    }
  }

  const open = insideFence(text);
  if (open === null) return text;

  // The closer keeps the opener's indentation so it still lands inside whatever list item
  // or blockquote the fence was opened in.
  const closer = `${open.indent}${open.marker}`;
  return text.endsWith('\n') ? `${text}${closer}\n` : `${text}\n${closer}\n`;
}

interface OpenFence {
  indent: string;
  marker: string;
}

/** The fence still open at the end of `text`, or null when the document is balanced. */
function insideFence(text: string): OpenFence | null {
  let open: OpenFence | null = null;

  for (const line of text.split('\n')) {
    const match = FENCE.exec(line);
    if (match === null) continue;
    const marker = match[2] ?? '';

    if (open === null) {
      open = { indent: match[1] ?? '', marker };
      continue;
    }

    // A fence closes only on its own character, at least as long, and with nothing after
    // it — which is why a ``` inside a ~~~ block, or inside a longer ```` block, is text.
    const rest = match[3] ?? '';
    if (marker[0] === open.marker[0] && marker.length >= open.marker.length && rest.trim() === '') {
      open = null;
    }
  }

  return open;
}

/**
 * Splits a fence info string into the language and the filename an agent tacked onto it.
 *
 * There is no standard here, so the three shapes seen in practice all work:
 * ```ts src/foo.ts```, ```ts title="src/foo.ts"``` and ```ts filename=src/foo.ts```.
 */
export function parseFenceInfo(lang: string | null, meta: string | null): {
  lang: string | null;
  filename: string | null;
} {
  const trimmed = meta?.trim() ?? '';
  if (trimmed === '') return { lang, filename: null };

  const keyed = /(?:title|filename|file|name)\s*=\s*"?([^"\s]+)"?/i.exec(trimmed);
  if (keyed?.[1] !== undefined) return { lang, filename: keyed[1] };

  const bare = trimmed.split(/\s+/)[0] ?? '';
  // A bare word only reads as a filename when it looks like one; `{highlight}` and
  // similar renderer directives must not end up in the header.
  return { lang, filename: /^[\w./\\@-]+\.\w+$/.test(bare) ? bare : null };
}
