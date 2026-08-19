/**
 * The fallback renderer, and the one every other renderer falls back to.
 *
 * Wrapping rather than scrolling horizontally: an artifact is read in a dock column, and
 * a horizontal scrollbar per paragraph makes prose unreadable there.
 */
export function TextArtifact({ content }: { content: string }): React.JSX.Element {
  return (
    <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
      {content}
    </pre>
  );
}
