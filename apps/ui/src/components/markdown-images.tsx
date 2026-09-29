import { defaultUrlTransform, type UrlTransform } from 'react-markdown';

export const markdownUrlTransform: UrlTransform = (value, key, node) => {
  // Keep image sources intact so the renderer can show rejected sources as links instead
  // of losing their URL to react-markdown's default protocol filter first.
  return key === 'src' && node.tagName === 'img' ? value : defaultUrlTransform(value);
};

export function SafeMarkdownImage({
  src,
  alt,
  imageClassName,
  linkClassName,
}: {
  src?: string;
  alt?: string;
  imageClassName?: string;
  linkClassName?: string;
}): React.JSX.Element {
  if (src && isAllowedImageSource(src)) {
    return <img src={src} alt={alt} className={imageClassName} />;
  }

  return (
    <a
      href={src ? defaultUrlTransform(src) || undefined : undefined}
      target="_blank"
      rel="noreferrer noopener"
      className={linkClassName}
    >
      {src}
    </a>
  );
}

function isAllowedImageSource(src: string): boolean {
  if (/^data:/i.test(src.trim())) return true;

  try {
    const resolved = new URL(src, document.baseURI);
    return resolved.origin === window.location.origin;
  } catch {
    return false;
  }
}
