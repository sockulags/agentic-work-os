import { useMemo } from 'react';
import { parseDelimitedTable } from '@/lib/artifact-table';
import { TableArtifact } from './TableArtifact';
import { TextArtifact } from './TextArtifact';

/**
 * A `.csv` or `.tsv` file. Anything the parser cannot find a grid in falls back to plain
 * text rather than a one-column table, because a file that was never tabular reads better
 * as what it is.
 */
export function CsvArtifact({ content }: { content: string }): React.JSX.Element {
  const table = useMemo(() => parseDelimitedTable(content), [content]);

  if (table === null) return <TextArtifact content={content} />;
  return <TableArtifact table={table} />;
}
