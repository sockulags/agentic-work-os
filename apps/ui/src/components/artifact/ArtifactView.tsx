import type { Artifact } from '@/lib/artifacts';
import { MarkdownArtifact } from './MarkdownArtifact';
import { MermaidArtifact } from './MermaidArtifact';
import { JsonArtifact } from './JsonArtifact';
import { CsvArtifact } from './CsvArtifact';
import { HtmlArtifact } from './HtmlArtifact';
import { ImageArtifact } from './ImageArtifact';
import { TextArtifact } from './TextArtifact';

/**
 * Picks the renderer for an artifact's kind.
 *
 * The kind comes from the file extension the agent chose (see `artifact-store.ts`), which
 * makes it a hint rather than a guarantee — every renderer below degrades to showing the
 * source when the content does not match its promise, so a mislabelled file is still
 * readable.
 */
export function ArtifactView({ artifact }: { artifact: Artifact }): React.JSX.Element {
  switch (artifact.kind) {
    case 'markdown':
      return <MarkdownArtifact content={artifact.content} />;
    case 'mermaid':
      return <MermaidArtifact id={artifact.id} source={artifact.content} />;
    case 'json':
      return <JsonArtifact content={artifact.content} />;
    case 'csv':
      return <CsvArtifact content={artifact.content} />;
    case 'html':
      return <HtmlArtifact content={artifact.content} title={artifact.title} />;
    case 'image':
      return <ImageArtifact src={artifact.content} alt={artifact.title} />;
    case 'text':
      return <TextArtifact content={artifact.content} />;
  }
}
