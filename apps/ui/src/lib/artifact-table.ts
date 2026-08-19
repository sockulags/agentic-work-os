/**
 * Turning an artifact into a table.
 *
 * Two very different sources land in the same viewer: a delimited text file, and a JSON
 * array of objects. Both are how an agent naturally dumps a result set, and both are far
 * more useful sorted in a grid than as a wall of text. Keeping the conversion here — pure,
 * string-in/table-out — means the renderer only ever deals with one shape.
 *
 * Everything degrades to null rather than throwing. A file whose extension promises CSV
 * but whose contents are prose is a real thing agents produce; the caller falls back to
 * showing the raw text, which is more honest than a one-column table.
 */

export interface ArtifactTable {
  columns: string[];
  /** Row cells, already stringified and aligned to `columns` by index. */
  rows: string[][];
}

export type SortDirection = 'asc' | 'desc';

/** Delimiters worth sniffing for. `.tsv` arrives as kind `csv`, hence the tab. */
const DELIMITERS = [',', '\t', ';'] as const;

/**
 * Parse delimited text, or null when there is nothing tabular in it.
 *
 * The delimiter is sniffed from the header line rather than assumed, because the core
 * maps `.tsv` onto the same `csv` kind as `.csv` and the extension is therefore not
 * enough to tell them apart.
 */
export function parseDelimitedTable(text: string): ArtifactTable | null {
  // `trim` also removes a leading byte-order mark — U+FEFF is whitespace per spec — which
  // is worth knowing because a BOM left in place would end up inside the first heading.
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const delimiter = sniffDelimiter(trimmed);
  if (delimiter === null) return null;

  const records = parseRecords(trimmed, delimiter);
  const header = records[0];
  if (header === undefined || header.length < 2) return null;

  // The grid is as wide as the widest record, not as wide as the header. A row with more
  // fields than the header means something upstream went wrong — an unquoted delimiter
  // inside a cell, usually — and truncating it would hide the damage behind a row that
  // still looks plausible.
  const width = records.reduce((widest, record) => Math.max(widest, record.length), 0);

  // Blank and absent header cells still occupy a column — dropping them would shift every
  // cell in every row one place to the left.
  const columns = Array.from({ length: width }, (_, i) => {
    const heading = header[i]?.trim() ?? '';
    return heading === '' ? `Column ${i + 1}` : heading;
  });

  const rows = records.slice(1).map((record) =>
    columns.map((_, i) => record[i] ?? ''),
  );

  return { columns, rows };
}

/**
 * Parse a JSON array of objects into a table, or null for any other shape.
 *
 * Columns are the union of every row's keys in first-seen order, so a record that omits
 * an optional field does not silently truncate the grid for everyone else.
 */
export function jsonTable(value: unknown): ArtifactTable | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every(isPlainObject)) return null;

  const columns: string[] = [];
  for (const row of value) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  if (columns.length === 0) return null;

  const rows = value.map((row) => columns.map((key) => formatCell(row[key])));
  return { columns, rows };
}

/**
 * Compare two non-empty cells, ascending.
 *
 * Numbers sort numerically when both sides are numbers — a column of durations ordering
 * as `1, 10, 2` is the classic way a sortable table stops being trusted. Everything else
 * falls back to a locale compare.
 *
 * Empty cells are not this function's business; `sortTableRows` handles them, because
 * their rule is the one thing in the sort that does not flip with the direction.
 */
export function compareCells(a: string, b: string): number {
  if (a === b) return 0;

  const na = Number(a);
  const nb = Number(b);
  if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) {
    return na - nb;
  }

  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function sortTableRows(
  rows: readonly string[][],
  columnIndex: number,
  direction: SortDirection,
): string[][] {
  const factor = direction === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    const left = a[columnIndex] ?? '';
    const right = b[columnIndex] ?? '';

    // Blanks sink to the bottom whichever way the column is sorted. A missing value is
    // the absence of an answer, not an answer that happens to sort below every other
    // one, and letting a block of empty rows take the top of a descending sort buries
    // exactly the rows the reader clicked the header to see.
    if (left === '' || right === '') return (left === '' ? 1 : 0) - (right === '' ? 1 : 0);

    return factor * compareCells(left, right);
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function sniffDelimiter(text: string): string | null {
  const header = firstLine(text);

  let best: string | null = null;
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    const count = parseRecords(header, delimiter)[0]?.length ?? 0;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }

  return bestCount >= 2 ? best : null;
}

/** The header may itself contain quoted newlines, so the split is quote-aware. */
function firstLine(text: string): string {
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') quoted = !quoted;
    else if (char === '\n' && !quoted) return text.slice(0, i);
  }
  return text;
}

/**
 * RFC 4180 field splitting: quoted fields may contain the delimiter, newlines, and
 * doubled quotes. Agents produce quoted CSV constantly (any cell with a comma in it), so
 * a naive `split(',')` would mangle a large share of real artifacts.
 */
function parseRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;

  const endField = (): void => {
    record.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    if (record.length > 1 || record[0] !== '') records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') quoted = true;
    else if (char === delimiter) endField();
    else if (char === '\n') endRecord();
    else if (char !== '\r') field += char;
  }

  if (field !== '' || record.length > 0) endRecord();
  return records;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
