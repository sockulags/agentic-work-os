import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { createLowlight } from 'lowlight';
import type { RootContent } from 'hast';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { cn } from '@/lib/utils';
import './markdown.css';

/**
 * Fenced code, highlighted as it streams.
 *
 * highlight.js rather than shiki, for two reasons that both come from streaming. It
 * highlights synchronously, so a block is coloured on the same paint that shows its text
 * — shiki's async path would render plain and then swap, which is the flicker this whole
 * unit exists to avoid. And it emits class names, so the theme lives in CSS next to the
 * app's own tokens instead of the inline hex colours a shiki theme bakes in. Registering
 * a handful of grammars by hand rather than pulling `common` keeps the cost near a tenth
 * of shiki's TextMate grammars.
 */
const lowlight = createLowlight({
  bash,
  css,
  diff,
  go,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
});

/** Past this a block is pasted data, and colouring it costs more than it returns. */
const MAX_HIGHLIGHT_CHARS = 50_000;

/**
 * The budget while the block is still arriving.
 *
 * Highlighting runs from the top of the block on every delta, so the work over a whole
 * stream grows with the square of the block's length. Well under the settled cap that is
 * cheap; a 40 kB file streamed token by token is not. Big blocks therefore stay plain
 * until they finish — the one place where colour appearing late beats a stuttering paint.
 */
const MAX_STREAMING_CHARS = 8_000;

/** Guessing is a scan against every grammar, so it is only worth it on short blocks. */
const MAX_AUTODETECT_CHARS = 4_000;

/** Below this, highlight.js's own confidence in a guess is too low to put in the header. */
const MIN_AUTODETECT_RELEVANCE = 5;

interface CodeBlockProps {
  code: string;
  lang: string | null;
  filename: string | null;
  streaming: boolean;
}

export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  filename,
  streaming,
}: CodeBlockProps): React.JSX.Element {
  const highlighted = useMemo(() => highlight(code, lang, streaming), [code, lang, streaming]);
  const label = filename ?? highlighted.language ?? 'text';

  return (
    <figure className="awos-code my-3 overflow-hidden rounded-md border border-border bg-muted/30">
      <figcaption className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-mono text-[11px]',
            filename !== null ? 'text-foreground/80' : 'text-muted-foreground',
          )}
        >
          {label}
        </span>
        <CopyButton code={code} />
      </figcaption>
      <pre className="awos-scroll max-h-[32rem] overflow-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed">
        <code>{highlighted.nodes ?? code}</code>
      </pre>
    </figure>
  );
});

function CopyButton({ code }: { code: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    // Failing silently is right here: the text is on screen and selectable, and a red
    // error in the middle of a transcript over a copy button is worse than no feedback.
    void navigator.clipboard
      ?.writeText(code)
      .then(() => setCopied(true))
      .catch(() => undefined);
  }, [code]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : 'Copy code'}
      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

interface Highlighted {
  nodes: React.ReactNode[] | null;
  language: string | null;
}

function highlight(code: string, lang: string | null, streaming: boolean): Highlighted {
  const budget = streaming ? MAX_STREAMING_CHARS : MAX_HIGHLIGHT_CHARS;
  if (code.length > budget) return { nodes: null, language: lang };

  try {
    if (lang !== null && lowlight.registered(lang)) {
      return { nodes: toReact(lowlight.highlight(lang, code).children), language: lang };
    }
    if (lang === null && code.length <= MAX_AUTODETECT_CHARS) {
      const guess = lowlight.highlightAuto(code);
      // A guess made on prose or a log excerpt scores near zero and would otherwise put a
      // confident, wrong language in the header.
      const confident = (guess.data?.relevance ?? 0) >= MIN_AUTODETECT_RELEVANCE;
      return { nodes: toReact(guess.children), language: confident ? guess.data?.language ?? null : null };
    }
  } catch {
    // A grammar can throw on input it was never meant to see. Plain text still reads.
  }

  return { nodes: null, language: lang };
}

/**
 * Renders lowlight's hast output as elements rather than injecting its HTML.
 *
 * The tree is only ever spans and text, so this stays short — and it keeps the promise
 * that nothing an agent writes reaches the DOM as markup.
 */
function toReact(nodes: readonly RootContent[]): React.ReactNode[] {
  return nodes.map((node, i) => {
    if (node.type === 'text') return node.value;
    if (node.type !== 'element') return null;

    const className = node.properties?.['className'];
    return (
      <span key={i} className={Array.isArray(className) ? className.join(' ') : undefined}>
        {toReact(node.children)}
      </span>
    );
  });
}
