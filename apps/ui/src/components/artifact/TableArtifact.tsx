import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { sortTableRows, type ArtifactTable, type SortDirection } from '@/lib/artifact-table';
import { cn } from '@/lib/utils';

/**
 * A sortable grid for delimited files and JSON arrays of objects.
 *
 * Sorting is three-state — ascending, descending, then back to the file's own order —
 * because the order an agent wrote the rows in is often the answer (a ranking, a
 * timeline), and a table you cannot un-sort loses that permanently.
 */
interface Sort {
  column: number;
  /** The heading the sort was requested on, so it can be re-checked against the table. */
  columnName: string;
  direction: SortDirection;
}

export function TableArtifact({ table }: { table: ArtifactTable }): React.JSX.Element {
  const [requested, setRequested] = useState<Sort | null>(null);

  // An artifact keeps its id when an agent rewrites it, so the same component can be handed
  // a table with different columns. A sort left pointing at a column that has moved or gone
  // would compare a column of blanks — every row equal, file order on screen, and a header
  // arrow claiming a sort that is not there. Re-checking the heading discards exactly those
  // and keeps the sort across rewrites that only changed the rows.
  const sort = requested !== null && table.columns[requested.column] === requested.columnName
    ? requested
    : null;

  const rows = useMemo(
    () => (sort === null ? table.rows : sortTableRows(table.rows, sort.column, sort.direction)),
    [table.rows, sort],
  );

  const cycle = (column: number): void => {
    const columnName = table.columns[column] ?? '';

    if (sort === null || sort.column !== column) {
      setRequested({ column, columnName, direction: 'asc' });
      return;
    }
    setRequested(sort.direction === 'asc' ? { column, columnName, direction: 'desc' } : null);
  };

  return (
    <div className="px-4 py-3">
      <p className="mb-2 text-xs text-muted-foreground">
        {table.rows.length} {table.rows.length === 1 ? 'row' : 'rows'} &middot;{' '}
        {table.columns.length} {table.columns.length === 1 ? 'column' : 'columns'}
      </p>

      <div className="awos-scroll overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              {table.columns.map((column, i) => {
                const active = sort?.column === i;
                const Icon = !active ? ChevronsUpDown : sort.direction === 'asc' ? ArrowUp : ArrowDown;

                return (
                  <th
                    key={`${i}:${column}`}
                    scope="col"
                    aria-sort={!active ? 'none' : sort.direction === 'asc' ? 'ascending' : 'descending'}
                    className="border-b border-border bg-muted/40 p-0 text-left font-medium"
                  >
                    <button
                      type="button"
                      onClick={() => cycle(i)}
                      className="flex w-full items-center gap-1 px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className="truncate">{column}</span>
                      <Icon
                        className={cn(
                          'ml-auto h-3 w-3 shrink-0',
                          active ? 'text-foreground' : 'text-muted-foreground/50',
                        )}
                      />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="even:bg-muted/20">
                {table.columns.map((_, columnIndex) => (
                  <td
                    key={columnIndex}
                    className="max-w-[24rem] whitespace-pre-wrap break-words border-b border-border/50 px-2 py-1 align-top"
                  >
                    {row[columnIndex] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
