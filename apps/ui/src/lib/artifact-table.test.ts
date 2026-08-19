import { describe, expect, it } from 'vitest';
import { compareCells, jsonTable, parseDelimitedTable, sortTableRows } from './artifact-table';

describe('parseDelimitedTable', () => {
  it('reads a comma-separated file', () => {
    const table = parseDelimitedTable('name,count\nalpha,2\nbeta,10\n');

    expect(table).toEqual({
      columns: ['name', 'count'],
      rows: [
        ['alpha', '2'],
        ['beta', '10'],
      ],
    });
  });

  it('sniffs tabs, which arrive under the same csv kind', () => {
    expect(parseDelimitedTable('name\tcount\nalpha\t2')?.columns).toEqual(['name', 'count']);
  });

  it('sniffs semicolons', () => {
    expect(parseDelimitedTable('name;count\nalpha;2')?.columns).toEqual(['name', 'count']);
  });

  it('keeps delimiters and newlines inside quoted fields', () => {
    const table = parseDelimitedTable('a,b\n"one, two","line\nbreak"');

    expect(table?.rows).toEqual([['one, two', 'line\nbreak']]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseDelimitedTable('a,b\n"say ""hi""",2')?.rows).toEqual([['say "hi"', '2']]);
  });

  it('tolerates CRLF line endings', () => {
    expect(parseDelimitedTable('a,b\r\n1,2\r\n')?.rows).toEqual([['1', '2']]);
  });

  it('pads rows that are short of the header', () => {
    expect(parseDelimitedTable('a,b,c\n1,2')?.rows).toEqual([['1', '2', '']]);
  });

  it('widens the table for a row that overflows the header instead of truncating it', () => {
    const table = parseDelimitedTable('a,b\n1,2\n3,4,5');

    expect(table?.columns).toEqual(['a', 'b', 'Column 3']);
    expect(table?.rows).toEqual([
      ['1', '2', ''],
      ['3', '4', '5'],
    ]);
  });

  it('names blank header cells rather than dropping the column', () => {
    const table = parseDelimitedTable('a,,c\n1,2,3');

    expect(table?.columns).toEqual(['a', 'Column 2', 'c']);
    expect(table?.rows).toEqual([['1', '2', '3']]);
  });

  it('skips blank lines', () => {
    expect(parseDelimitedTable('a,b\n1,2\n\n3,4\n')?.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('returns null for prose, which has no delimiter to find', () => {
    expect(parseDelimitedTable('Just a sentence about the build.')).toBeNull();
  });

  it('returns null for a single-column file', () => {
    expect(parseDelimitedTable('name\nalpha\nbeta')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseDelimitedTable('   \n  ')).toBeNull();
  });

  it('reads a header-only file as a table with no rows', () => {
    expect(parseDelimitedTable('a,b')).toEqual({ columns: ['a', 'b'], rows: [] });
  });
});

describe('jsonTable', () => {
  it('builds columns from the union of keys, in first-seen order', () => {
    const table = jsonTable([
      { name: 'alpha', count: 2 },
      { count: 10, extra: true },
    ]);

    expect(table).toEqual({
      columns: ['name', 'count', 'extra'],
      rows: [
        ['alpha', '2', ''],
        ['', '10', 'true'],
      ],
    });
  });

  it('serializes nested values rather than showing [object Object]', () => {
    expect(jsonTable([{ meta: { a: 1 } }])?.rows).toEqual([['{"a":1}']]);
  });

  it('rejects shapes that are not an array of objects', () => {
    expect(jsonTable({ a: 1 })).toBeNull();
    expect(jsonTable([])).toBeNull();
    expect(jsonTable([1, 2, 3])).toBeNull();
    expect(jsonTable([{ a: 1 }, 'not an object'])).toBeNull();
    expect(jsonTable([[1, 2]])).toBeNull();
    expect(jsonTable([null])).toBeNull();
  });

  it('rejects an array of objects with no keys at all', () => {
    expect(jsonTable([{}, {}])).toBeNull();
  });
});

describe('compareCells', () => {
  it('orders numbers numerically', () => {
    expect(['10', '2', '1'].sort(compareCells)).toEqual(['1', '2', '10']);
  });

  it('orders text alphabetically', () => {
    expect(['beta', 'Alpha'].sort(compareCells)).toEqual(['Alpha', 'beta']);
  });

});

describe('sortTableRows', () => {
  const rows = [
    ['alpha', '10'],
    ['beta', '2'],
  ];

  it('sorts ascending without mutating the input', () => {
    expect(sortTableRows(rows, 1, 'asc')).toEqual([
      ['beta', '2'],
      ['alpha', '10'],
    ]);
    expect(rows[0]?.[0]).toBe('alpha');
  });

  it('sorts descending', () => {
    expect(sortTableRows(rows, 1, 'desc')).toEqual([
      ['alpha', '10'],
      ['beta', '2'],
    ]);
  });

  it('treats a missing cell as empty', () => {
    expect(sortTableRows([['a'], ['b', 'z']], 1, 'asc')).toEqual([['b', 'z'], ['a']]);
  });

  it('pins empty cells last whichever way the column is sorted', () => {
    const withBlank = [['a', ''], ['b', '2'], ['c', '10']];

    expect(sortTableRows(withBlank, 1, 'asc').map((row) => row[0])).toEqual(['b', 'c', 'a']);
    expect(sortTableRows(withBlank, 1, 'desc').map((row) => row[0])).toEqual(['c', 'b', 'a']);
  });
});
