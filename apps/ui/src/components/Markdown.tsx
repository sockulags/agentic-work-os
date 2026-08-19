import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type { Element, ElementContent } from 'hast';
import { parseFenceInfo, prepareMarkdown } from '@/lib/markdown-stream';
import { CodeBlock } from './CodeBlock';
import { cn } from '@/lib/utils';
import './markdown.css';

/**
 * Agent messages, rendered as the markdown they have always been.
 *
 * Two things are load-bearing here. The source runs through `prepareMarkdown` first, so a
 * fence that is still being written is already a code block and the tail of the message
 * does not reflow when its closing marker lands. And the component is memoised on its
 * text: a delta belongs to one message, and re-parsing every other message in a long
 * thread on every token is what makes a streaming transcript stutter.
 *
 * Raw HTML never reaches the DOM — react-markdown drops it unless `rehype-raw` is added,
 * and it is deliberately not added. Link targets go through the library's own URL
 * transform, which keeps `javascript:` out.
 */

/**
 * `remark-breaks` is here to keep a promise the old renderer made. Agents write plain
 * text with meaningful single newlines constantly — a list of changed paths, a couple of
 * shell commands, a short stack trace — and `whitespace-pre-wrap` used to honour them.
 * Strict markdown would join those into one paragraph, which reads as a regression no
 * matter how correct it is.
 */
const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}): React.JSX.Element {
  const source = useMemo(() => prepareMarkdown(text, streaming), [text, streaming]);
  // Every fenced block needs to know, and threading it as a prop through react-markdown's
  // component map is not possible — the map is a module constant on purpose.
  const components = useMemo(() => componentsFor(streaming), [streaming]);

  return (
    <div
      className={cn(
        'awos-markdown break-words text-sm leading-relaxed text-foreground/90',
        streaming && 'awos-markdown-streaming',
      )}
    >
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
});

function componentsFor(streaming: boolean): Components {
  return {
    ...COMPONENTS,
    pre({ node, children }) {
      const code = node?.children[0];
      if (code?.type === 'element' && code.tagName === 'code') {
        const info = parseFenceInfo(languageOf(code), code.data?.meta ?? null);
        return (
          <CodeBlock
            code={textOf(code.children)}
            lang={info.lang}
            filename={info.filename}
            streaming={streaming}
          />
        );
      }
      return (
        <pre className="awos-scroll my-3 overflow-auto rounded-md bg-muted/40 p-3">{children}</pre>
      );
    },
  };
}

const COMPONENTS: Components = {

  // Only inline code reaches this: fenced code is intercepted at `pre` above.
  code({ children }) {
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">
        {children}
      </code>
    );
  },

  a({ children, href }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
      >
        {children}
      </a>
    );
  },

  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  h1: ({ children }) => <h2 className="mb-2 mt-5 text-base font-semibold text-foreground first:mt-0">{children}</h2>,
  h2: ({ children }) => <h3 className="mb-2 mt-5 text-[0.95rem] font-semibold text-foreground first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-2 mt-4 text-sm font-semibold text-foreground first:mt-0">{children}</h4>,
  h4: ({ children }) => <h5 className="mb-1.5 mt-4 text-sm font-medium text-foreground first:mt-0">{children}</h5>,
  h5: ({ children }) => <h6 className="mb-1.5 mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground first:mt-0">{children}</h6>,
  h6: ({ children }) => <h6 className="mb-1.5 mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground first:mt-0">{children}</h6>,

  // A GFM task list carries its own marker — the checkbox — so the bullet comes off.
  ul: ({ children, node }) => (
    <ul
      className={cn(
        'mb-3 space-y-1 last:mb-0 marker:text-muted-foreground',
        hasClass(node, 'contains-task-list') ? 'list-none' : 'ml-5 list-disc',
      )}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-3 ml-5 list-decimal space-y-1 last:mb-0 marker:text-muted-foreground">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="[&>ol]:mb-0 [&>ol]:mt-1 [&>p]:mb-0 [&>ul]:mb-0 [&>ul]:mt-1">{children}</li>
  ),

  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-border pl-3 text-muted-foreground last:mb-0">
      {children}
    </blockquote>
  ),

  hr: () => <hr className="my-4 border-t border-border" />,

  // A wide table has to scroll inside its own box; letting it widen the column would
  // push the whole transcript sideways.
  table: ({ children }) => (
    <div className="awos-scroll mb-3 overflow-x-auto rounded-md border border-border last:mb-0">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/40">{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-border last:border-b-0">{children}</tr>,
  th: ({ children, style }) => (
    <th style={style} className="px-3 py-1.5 text-left font-medium text-foreground">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="px-3 py-1.5 align-top text-foreground/85">
      {children}
    </td>
  ),

  // Task-list state belongs to the agent's message, not to the reader: `disabled` is what
  // stops a click, `readOnly` only stops React complaining about a checkbox with no
  // change handler.
  input: ({ checked, type }) =>
    type === 'checkbox' ? (
      <input
        type="checkbox"
        checked={checked}
        disabled
        readOnly
        className="mr-1.5 align-middle accent-foreground"
      />
    ) : null,

  img: ({ src, alt }) => (
    <img src={src} alt={alt} className="my-3 max-w-full rounded-md border border-border" />
  ),
};

function languageOf(code: Element): string | null {
  const className = code.properties?.['className'];
  if (!Array.isArray(className)) return null;
  for (const entry of className) {
    if (typeof entry === 'string' && entry.startsWith('language-')) {
      return entry.slice('language-'.length) || null;
    }
  }
  return null;
}

function hasClass(node: Element | undefined, name: string): boolean {
  const className = node?.properties?.['className'];
  return Array.isArray(className) && className.includes(name);
}

/**
 * The literal text of a fence, taken from the tree rather than from React children.
 *
 * The trailing newline goes: every code node carries one by construction, and inside a
 * `<pre>` it shows up as a blank line under the last line of code.
 */
function textOf(nodes: readonly ElementContent[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') out += node.value;
    else if (node.type === 'element') out += textOf(node.children);
  }
  return out.endsWith('\n') ? out.slice(0, -1) : out;
}
