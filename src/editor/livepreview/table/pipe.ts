// Pipe tables as Pandoc reads them, and their aligned serialization. Pure functions over strings.
// A cell holds its inline Markdown as typed, except that `\|` reads as `|`.

export type Align = "" | "left" | "center" | "right";

export interface PipeTable {
  header: string[];
  align: Align[];
  rows: string[][];
}

/** `: Caption {#tbl:x}` or `Table: Caption`, split so that formatting it again gives the same text. */
export interface Caption {
  /** `: ` or `Table: `, with the spaces after it. */
  prefix: string;
  text: string;
  /** The text inside a trailing `{…}`, or null when there is none. */
  attrs: string | null;
  /** Spaces between the text and `{`. */
  gap: string;
  /** Spaces at the end. */
  trail: string;
}

/** A Table syntax node's text: the table, and a caption written on the lines right below it. */
export interface TableBlock {
  table: PipeTable;
  /** Offset of the caption lines in the block text, or -1. */
  captionAt: number;
  caption: Caption | null;
}

/** End (exclusive) of the code span opening at `start`, or -1 when it is not closed on the line. */
function codeSpanEnd(text: string, start: number): number {
  let n = 1;
  while (text[start + n] === "`") n++;
  const run = "`".repeat(n);
  for (let at = text.indexOf(run, start + n); at >= 0; at = text.indexOf(run, at + n)) {
    if (text[at + n] !== "`" && text[at - 1] !== "`") return at + n;
  }
  return -1;
}

/** Walks `text` calling `out` for each piece: escapes and code spans whole, other characters one by one. */
function scan(text: string, out: (piece: string, plain: boolean) => void) {
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      out(text.slice(i, i + 2), false);
      i += 2;
    } else if (c === "`") {
      let n = 1;
      while (text[i + n] === "`") n++;
      const end = codeSpanEnd(text, i);
      const to = end < 0 ? i + n : end;
      out(text.slice(i, to), false);
      i = to;
    } else {
      out(c, true);
      i++;
    }
  }
}

/** The cells of a pipe table line (outer pipes optional), or null when it has no separating pipe. */
export function splitRow(line: string): string[] | null {
  const text = line.trim();
  const cells: string[] = [];
  let cell = "";
  let pipes = 0;
  let endsWithPipe = false;
  scan(text, (piece, plain) => {
    endsWithPipe = plain && piece === "|";
    if (endsWithPipe) {
      cells.push(cell);
      cell = "";
      pipes++;
    } else cell += piece;
  });
  if (!endsWithPipe) cells.push(cell);
  if (pipes === 0) return null;
  if (text.startsWith("|")) cells.shift();
  return cells.map((c) => unescapeCell(c.trim()));
}

export function unescapeCell(raw: string): string {
  let out = "";
  scan(raw, (piece) => (out += piece === "\\|" ? "|" : piece));
  return out;
}

export function escapeCell(text: string): string {
  let out = "";
  scan(text, (piece, plain) => (out += plain && piece === "|" ? "\\|" : piece));
  return out;
}

const DELIMITER_CELL = /^:?-+:?$/;

function alignOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : left ? "left" : right ? "right" : "";
}

const CAPTION = /^(?:Table|table)?:[ \t]/;

export function isCaptionStart(line: string): boolean {
  return CAPTION.test(line.trimStart());
}

export function parseCaption(text: string): Caption | null {
  const m = /^((?:Table|table)?:[ \t]+)([\s\S]*?)(?:([ \t]+)\{([^{}\n]*)\})?([ \t]*)$/.exec(text);
  if (!m) return null;
  return { prefix: m[1], text: m[2], gap: m[3] ?? "", attrs: m[4] ?? null, trail: m[5] };
}

export function formatCaption(c: Caption): string {
  return `${c.prefix}${c.text}${c.attrs === null ? "" : `${c.gap}{${c.attrs}}`}${c.trail}`;
}

export function captionId(c: Caption): string {
  return c.attrs === null ? "" : (/(?:^|\s)#([^\s}]+)/.exec(c.attrs)?.[1] ?? "");
}

/** The caption with `id` as its identifier; an empty id removes it (and empty braces). */
export function withCaptionId(c: Caption, id: string): Caption {
  const attrs = c.attrs ?? "";
  const m = /(^|\s+)#[^\s}]+/.exec(attrs);
  const before = m ? attrs.slice(0, m.index) : "";
  const after = m ? attrs.slice(m.index + m[0].length) : "";
  let next: string;
  if (m && id) next = `${before}${m[1]}#${id}${after}`;
  else if (m) next = `${before}${after}`.trim();
  else if (id) next = attrs.trim() ? `#${id} ${attrs.trim()}` : `#${id}`;
  else next = attrs;
  if (!next.trim()) return { ...c, attrs: null, gap: "" };
  return { ...c, attrs: next, gap: c.gap || " " };
}

/** The table in a Table node's text, or null when it is not a pipe table this editor can keep intact. */
export function parseTableBlock(text: string): TableBlock | null {
  const lines = text.split("\n");
  if (lines.length < 2) return null;
  const header = splitRow(lines[0]);
  const delimiter = splitRow(lines[1]);
  if (!header?.length || !delimiter || header.length !== delimiter.length || !delimiter.every((d) => DELIMITER_CELL.test(d))) {
    return null;
  }
  const width = header.length;
  const rows: string[][] = [];
  let captionLine = -1;
  for (let i = 2; i < lines.length; i++) {
    if (isCaptionStart(lines[i])) {
      captionLine = i;
      break;
    }
    const cells = splitRow(lines[i]);
    if (!cells || cells.length > width) return null;
    while (cells.length < width) cells.push("");
    rows.push(cells);
  }
  let captionAt = -1;
  let caption: Caption | null = null;
  if (captionLine >= 0) {
    captionAt = lines.slice(0, captionLine).join("\n").length + 1;
    caption = parseCaption(lines.slice(captionLine).join("\n"));
    if (!caption) return null;
  }
  return { table: { header, align: delimiter.map(alignOf), rows }, captionAt, caption };
}

/** Width as the eye counts it in a monospace editor: code points, not UTF-16 units. */
function width(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

function pad(text: string, w: number, align: Align): string {
  const extra = w - width(text);
  if (align === "right") return " ".repeat(extra) + text;
  if (align === "center") return " ".repeat(Math.floor(extra / 2)) + text + " ".repeat(Math.ceil(extra / 2));
  return text + " ".repeat(extra);
}

function dashes(w: number, align: Align): string {
  if (align === "left") return `:${"-".repeat(w + 1)}`;
  if (align === "right") return `${"-".repeat(w + 1)}:`;
  if (align === "center") return `:${"-".repeat(w)}:`;
  return "-".repeat(w + 2);
}

/** The table as an aligned pipe table: every column padded to its widest cell (at least 3). */
export function formatTable(t: PipeTable): string {
  const header = t.header.map(escapeCell);
  const rows = t.rows.map((r) => r.map(escapeCell));
  const widths = header.map((h, i) => Math.max(3, width(h), ...rows.map((r) => width(r[i] ?? ""))));
  const line = (cells: string[]) => `| ${widths.map((w, i) => pad(cells[i] ?? "", w, t.align[i])).join(" | ")} |`;
  return [line(header), `|${widths.map((w, i) => dashes(w, t.align[i])).join("|")}|`, ...rows.map(line)].join("\n");
}

/** The block text for `t`, keeping a caption written inside the block as it is. */
export function formatTableBlock(t: PipeTable, block: TableBlock, text: string): string {
  const table = formatTable(t);
  return block.captionAt < 0 ? table : `${table}\n${text.slice(block.captionAt)}`;
}

export interface LineChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * The smallest set of whole-line replacements that turns `before` into `after`: lines both share
 * at the start and end are kept, and when the lines in between are as many on both sides each
 * changed line is replaced on its own.
 */
export function lineChanges(before: string, after: string): LineChange[] {
  if (before === after) return [];
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const offsets = (lines: string[]) => {
    const out = [0];
    for (const l of lines) out.push(out[out.length - 1] + l.length + 1);
    return out;
  };
  const offA = offsets(a);
  if (endA - start === endB - start) {
    const changes: LineChange[] = [];
    for (let i = start; i < endA; i++) {
      if (a[i] !== b[i]) changes.push({ from: offA[i], to: offA[i] + a[i].length, insert: b[i] });
    }
    return changes;
  }
  // Each line taken with its newline; the text is read as if it ended in one more.
  const offB = offsets(b);
  const insert = `${after}\n`.slice(offB[start], offB[endB]);
  let from = offA[start];
  let to = offA[endA];
  if (to <= before.length) return [{ from, to, insert }];
  if (from === 0) return [{ from, to: before.length, insert: insert.slice(0, -1) }];
  from--;
  to--;
  return [{ from, to, insert: insert ? `\n${insert.slice(0, -1)}` : "" }];
}

export function setCell(t: PipeTable, row: number, col: number, text: string): PipeTable {
  const clean = text.replace(/\s*\r?\n\s*/g, " ").trim();
  if (row < 0) return { ...t, header: t.header.map((c, i) => (i === col ? clean : c)) };
  return { ...t, rows: t.rows.map((r, j) => (j === row ? r.map((c, i) => (i === col ? clean : c)) : r)) };
}

/** Adds an empty body row before body row `at` (`rows.length` appends). */
export function insertRow(t: PipeTable, at: number): PipeTable {
  const rows = [...t.rows];
  rows.splice(Math.max(0, Math.min(at, rows.length)), 0, t.header.map(() => ""));
  return { ...t, rows };
}

/** Removes body row `at`; a table keeps at least one body row. */
export function removeRow(t: PipeTable, at: number): PipeTable {
  if (t.rows.length <= 1 || at < 0 || at >= t.rows.length) return t;
  return { ...t, rows: t.rows.filter((_, j) => j !== at) };
}

/** Adds an empty column before column `at` (`header.length` appends), aligned like the default. */
export function insertColumn(t: PipeTable, at: number): PipeTable {
  const i = Math.max(0, Math.min(at, t.header.length));
  const add = <T>(list: T[], value: T) => [...list.slice(0, i), value, ...list.slice(i)];
  return { header: add(t.header, ""), align: add(t.align, "" as Align), rows: t.rows.map((r) => add(r, "")) };
}

/** Removes column `at`; a table keeps at least one column. */
export function removeColumn(t: PipeTable, at: number): PipeTable {
  if (t.header.length <= 1 || at < 0 || at >= t.header.length) return t;
  const drop = <T>(list: T[]) => list.filter((_, i) => i !== at);
  return { header: drop(t.header), align: drop(t.align), rows: t.rows.map(drop) };
}

export function setAlign(t: PipeTable, col: number, align: Align): PipeTable {
  return { ...t, align: t.align.map((a, i) => (i === col ? align : a)) };
}

export function hasHeader(t: PipeTable): boolean {
  return t.header.some((c) => c !== "");
}

/**
 * Turns the header row into the first body row, or the first body row into the header when the
 * header is empty (Pandoc reads a pipe table with an empty header as one without a header row).
 */
export function toggleHeader(t: PipeTable): PipeTable {
  const empty = t.header.map(() => "");
  if (hasHeader(t)) return { ...t, header: empty, rows: [t.header, ...t.rows] };
  if (t.rows.length === 0) return t;
  return { ...t, header: t.rows[0], rows: t.rows.length > 1 ? t.rows.slice(1) : [empty] };
}

/** `tbl:table`, or `tbl:table-2`… when taken. */
export function uniqueTableLabel(taken: Iterable<string>, stem = "table"): string {
  const used = new Set(taken);
  const base = `tbl:${stem}`;
  let label = base;
  for (let n = 2; used.has(label); n++) label = `${base}-${n}`;
  return label;
}

/** A label typed after `tbl:`: spaces become dashes, characters a label cannot hold are dropped. */
export function tableLabel(typed: string): string {
  const name = typed
    .trim()
    .replace(/^#?(tbl:)?/, "")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_.:-]/gu, "");
  return name ? `tbl:${name}` : "";
}
