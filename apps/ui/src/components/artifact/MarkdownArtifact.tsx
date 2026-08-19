import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Markdown artifacts: headings, lists, tables, code, links.
 *
 * Raw HTML stays off — `react-markdown` drops it unless `rehype-raw` is added, and it is
 * deliberately not added. An agent that wants to publish HTML has the `html` kind, which
 * renders in a sandboxed iframe; letting a `.md` file smuggle markup into this origin
 * would route around that.
 *
 * The component map exists because the repo has no typography plugin, so every element
 * needs its classes spelled out. Sizes are one step down from the transcript's: this is a
 * dock column, not the main reading surface.
 */
const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 mb-2 text-sm font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground first:mt-0">
      {children}
    </h3>
  ),
  p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  a: ({ href, children }) => (
    // Artifacts carry links an agent found on the web, so the referrer and the opener
    // handle are both withheld from whatever is on the other side.
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-foreground underline underline-offset-2 hover:text-foreground/80"
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    // `react-markdown` uses the same component for inline spans and fenced blocks; the
    // language class is what tells them apart.
    const fenced = typeof className === 'string' && className.includes('language-');
    if (fenced) {
      return (
        <code className="block font-mono text-xs leading-relaxed">{children}</code>
      );
    }
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
    );
  },
  pre: ({ children }) => (
    <pre className="awos-scroll my-2 overflow-x-auto rounded-md border border-border bg-muted/30 p-2">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="awos-scroll my-2 overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border bg-muted/40 px-2 py-1 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border/50 px-2 py-1 align-top">{children}</td>
  ),
};

export function MarkdownArtifact({ content }: { content: string }): React.JSX.Element {
  return (
    <div className="px-4 py-3 text-xs text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
