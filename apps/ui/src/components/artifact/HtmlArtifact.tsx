/**
 * Agent-authored HTML, rendered without letting it run.
 *
 * The `sandbox` attribute is present and empty, which is the strictest setting there is:
 * no scripts, no forms, no plugins, and a unique opaque origin, so the document cannot
 * reach the harness UI's DOM, storage or token. `allow-scripts` must never be added here
 * — the content is written by a model from whatever it read during the turn, and this
 * panel is inside the app's own origin.
 */
export function HtmlArtifact({
  content,
  title,
}: {
  content: string;
  title: string;
}): React.JSX.Element {
  return (
    <iframe
      title={title}
      srcDoc={content}
      sandbox=""
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-background"
    />
  );
}
