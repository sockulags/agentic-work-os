import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

type RenderState =
  | { status: 'rendering' }
  | { status: 'ok'; svg: string }
  | { status: 'error'; message: string };

/**
 * Mermaid diagrams.
 *
 * The package is loaded with a dynamic `import()` and never at module scope: it pulls in
 * its own parser and layout engine and is by a wide margin the heaviest thing in this
 * app, so paying for it on first paint — for a tab most sessions never open — is not a
 * trade worth making.
 *
 * `securityLevel: 'strict'` is what makes it safe to inject the result: mermaid encodes
 * HTML in node labels and disables `click` bindings, so a diagram authored by an agent
 * cannot carry markup or handlers into this origin.
 */
export function MermaidArtifact({
  id,
  source,
}: {
  id: string;
  source: string;
}): React.JSX.Element {
  const [state, setState] = useState<RenderState>({ status: 'rendering' });

  useEffect(() => {
    let live = true;
    setState({ status: 'rendering' });

    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          // The app is dark-only (`<html class="dark">`), so there is no theme to follow.
          theme: 'dark',
        });

        // Parsing first is what keeps a bad diagram contained: `render` reacts to a syntax
        // error by appending its own error graphic to the document body, outside React's
        // tree, where nothing here can clean it up.
        await mermaid.parse(source);

        const { svg } = await mermaid.render(nextRenderId(), source);
        if (live) setState({ status: 'ok', svg });
      } catch (err) {
        if (live) setState({ status: 'error', message: (err as Error).message });
      }
    })();

    return () => {
      live = false;
    };
  }, [id, source]);

  if (state.status === 'rendering') {
    return (
      <p className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Rendering diagram&hellip;
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="space-y-2 px-4 py-3">
        <p className="flex items-start gap-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>This diagram didn&rsquo;t parse: {state.message}</span>
        </p>
        {/* The source is the fix: a broken diagram is usually one wrong line, and showing
            it beats a blank panel that gives the author nothing to correct. */}
        <pre className="awos-scroll overflow-x-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-xs leading-relaxed">
          {source}
        </pre>
      </div>
    );
  }

  return (
    <div
      className="awos-scroll overflow-x-auto px-4 py-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  );
}

/**
 * Mermaid puts this straight into a DOM id and a CSS selector, so deriving it from the
 * artifact's file name would break on any name needing escaping (`flow chart.mmd`). A
 * counter sidesteps that and guarantees a fresh id per render, which matters because
 * mermaid emits styles keyed to the id alongside the SVG.
 */
let renderCount = 0;
function nextRenderId(): string {
  renderCount += 1;
  return `awos-mermaid-${renderCount}`;
}
