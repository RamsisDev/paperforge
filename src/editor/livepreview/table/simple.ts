// Pandoc simple tables (a header line over a dashed line, one row per line) converted to pipe
// tables, only when Pandoc reads both the same way. Grid and multiline tables set relative column
// widths, which a pipe table only keeps through the length of its dashes: they are left alone.

import { formatTable, type Align } from "./pipe";

/** Pandoc's default `--columns`: a pipe table with a longer line gets relative column widths. */
const COLUMNS = 72;

interface Column {
  start: number;
  end: number;
}

/** The dash runs of a simple table's dashed line (two columns or more), or null. */
export function dashColumns(line: string): Column[] | null {
  if (!/^ {0,3}-+( +-+)+ *$/.test(line)) return null;
  return [...line.matchAll(/-+/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

/** Pandoc's rule: text indented from the dashes' left end and reaching their right end is right aligned, and so on. */
function alignOf(raw: string, column: Column): Align {
  const text = raw.trimEnd();
  if (!text.trim()) return "";
  const leftSpace = text.startsWith(" ");
  const rightSpace = text.length < column.end - column.start;
  if (leftSpace && rightSpace) return "center";
  if (leftSpace) return "right";
  return rightSpace ? "left" : "";
}

/** A line cut at the columns' starts, or null when a word crosses a cut or text precedes the first column. */
function cut(line: string, columns: Column[]): string[] | null {
  if (line.includes("\t") || line.slice(0, columns[0].start).trim()) return null;
  const cells: string[] = [];
  for (let i = 0; i < columns.length; i++) {
    const from = columns[i].start;
    if (i > 0 && from <= line.length && line[from - 1] !== " ") return null;
    cells.push(line.slice(from, i + 1 < columns.length ? columns[i + 1].start : undefined));
  }
  return cells;
}

export interface Conversion {
  /** Index of the header line in `lines`. */
  first: number;
  /** Index of the last line the table takes (a closing dashed line included). */
  last: number;
  text: string;
}

/**
 * The pipe table for the simple table whose dashed line is `lines[dash]`, or null when it is not
 * one or the pipe table would not read the same: a cell ending in `\`, or a line longer than
 * Pandoc's column limit (which would turn on relative widths).
 */
export function convertSimpleTable(lines: readonly string[], dash: number): Conversion | null {
  const columns = dashColumns(lines[dash] ?? "");
  if (!columns || dash < 1 || !lines[dash - 1].trim() || (dash >= 2 && lines[dash - 2].trim())) return null;
  const rawHeader = cut(lines[dash - 1], columns);
  if (!rawHeader) return null;
  let last = dash;
  while (last + 1 < lines.length && lines[last + 1].trim()) last++;
  const body = lines.slice(dash + 1, last + 1);
  if (body.length && /^ *-+( +-+)* *$/.test(body[body.length - 1])) body.pop();
  if (!body.length) return null;
  const rows: string[][] = [];
  for (const line of body) {
    const cells = cut(line, columns);
    if (!cells) return null;
    rows.push(cells.map((c) => c.trim()));
  }
  const header = rawHeader.map((c) => c.trim());
  if ([header, ...rows].some((r) => r.some((c) => c.endsWith("\\")))) return null;
  const text = formatTable({ header, align: rawHeader.map((raw, i) => alignOf(raw, columns[i])), rows });
  if (text.split("\n").some((l) => l.length > COLUMNS)) return null;
  return { first: dash - 1, last, text };
}
