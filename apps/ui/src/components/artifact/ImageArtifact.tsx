/**
 * Images arrive as `data:` URIs in the event body, so there is nothing to fetch.
 *
 * That includes SVG, which the core also base64-encodes. Rendering it through `<img>`
 * rather than inlining the markup is deliberate: an `<img>` never runs the script or
 * loads the external references an agent-authored SVG might carry.
 */
export function ImageArtifact({
  src,
  alt,
}: {
  src: string;
  alt: string;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-center px-4 py-3">
      <img
        src={src}
        alt={alt}
        className="max-w-full rounded-md border border-border bg-background"
      />
    </div>
  );
}
