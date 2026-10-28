// A figure is a line holding only `![caption](src "title"){#fig:x .class key=value}`. Every edit
// below returns the smallest text change for one span of that line; the rest is kept verbatim.

export const FIGURE_EXTENSIONS = ["png", "jpg", "jpeg", "pdf"];

const MIME_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "application/pdf": "pdf" };

export interface Span {
  from: number;
  to: number;
}

export type FigureAttr = Span &
  (
    | { kind: "id" | "class"; value: string }
    | { kind: "pair"; key: string; value: string; valueFrom: number; valueTo: number }
    | { kind: "other" }
  );

export interface Figure {
  caption: Span & { text: string };
  src: Span & { text: string };
  /** After the closing `)`, where a missing attribute block goes. */
  end: number;
  /** The `{…}` block, braces included. */
  block: Span | null;
  attrs: FigureAttr[];
}

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

const isSpace = (c: string | undefined) => c === " " || c === "\t";

/** Index of the `close` matching an already opened `open`, skipping escapes and code spans. */
function closing(text: string, start: number, open: string, close: string): number {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "`") {
      let n = 1;
      while (text[i + n] === "`") n++;
      const run = "`".repeat(n);
      const end = text.indexOf(run, i + n);
      if (end >= 0) i = end + n - 1;
      else i += n - 1;
    } else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

/** End of a quoted value starting at `start` (the quote), or -1. */
function quoteEnd(text: string, start: number, end: number): number {
  const q = text[start];
  for (let i = start + 1; i < end; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === q) return i;
  }
  return -1;
}

function attributeBlockEnd(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const q = quoteEnd(text, i, text.length);
      if (q < 0) return -1;
      i = q;
    } else if (c === "}") return i;
  }
  return -1;
}

function parseAttrs(text: string, start: number, end: number, base: number): FigureAttr[] {
  const attrs: FigureAttr[] = [];
  let i = start;
  while (i < end) {
    if (isSpace(text[i])) {
      i++;
      continue;
    }
    const from = i;
    const lead = text[i];
    if (lead === "#" || lead === ".") {
      while (i < end && !isSpace(text[i])) i++;
      attrs.push({ kind: lead === "#" ? "id" : "class", value: text.slice(from + 1, i), from: base + from, to: base + i });
      continue;
    }
    while (i < end && !isSpace(text[i]) && text[i] !== "=") i++;
    if (text[i] !== "=" || i === from) {
      while (i < end && !isSpace(text[i])) i++;
      attrs.push({ kind: "other", from: base + from, to: base + i });
      continue;
    }
    const key = text.slice(from, i);
    const valueFrom = ++i;
    let value: string;
    if (text[i] === '"' || text[i] === "'") {
      const q = quoteEnd(text, i, end);
      i = q < 0 ? end : q + 1;
      value = text.slice(valueFrom + 1, q < 0 ? end : q).replace(/\\(.)/g, "$1");
    } else {
      while (i < end && !isSpace(text[i])) i++;
      value = text.slice(valueFrom, i);
    }
    attrs.push({ kind: "pair", key, value, valueFrom: base + valueFrom, valueTo: base + i, from: base + from, to: base + i });
  }
  return attrs;
}

/** The figure on `line` (whose first character is at document offset `base`), or null. */
export function parseFigure(line: string, base = 0): Figure | null {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  if (!line.startsWith("![", i)) return null;
  const captionFrom = i + 2;
  const captionTo = closing(line, captionFrom, "[", "]");
  if (captionTo < 0 || line[captionTo + 1] !== "(") return null;
  const srcStart = captionTo + 2;
  const srcEnd = closing(line, srcStart, "(", ")");
  if (srcEnd < 0) return null;
  const dest = /^\s*(<[^>]*>|\S+)/.exec(line.slice(srcStart, srcEnd));
  if (!dest) return null;
  const srcFrom = srcStart + dest[0].length - dest[1].length;
  let j = srcEnd + 1;
  let block: Span | null = null;
  let attrs: FigureAttr[] = [];
  if (line[j] === "{") {
    const close = attributeBlockEnd(line, j + 1);
    if (close < 0) return null;
    attrs = parseAttrs(line, j + 1, close, base);
    block = { from: base + j, to: base + close + 1 };
    j = close + 1;
  }
  if (line.slice(j).trim() !== "") return null;
  return {
    caption: { from: base + captionFrom, to: base + captionTo, text: line.slice(captionFrom, captionTo) },
    src: { from: base + srcFrom, to: base + srcFrom + dest[1].length, text: dest[1].replace(/^<|>$/g, "") },
    end: base + srcEnd + 1,
    block,
    attrs,
  };
}

export function figureId(fig: Figure): string {
  const id = fig.attrs.find((a) => a.kind === "id");
  return id && id.kind === "id" ? id.value : "";
}

export function figureAttribute(fig: Figure, key: string): string | null {
  const pair = fig.attrs.find((a) => a.kind === "pair" && a.key === key);
  return pair && pair.kind === "pair" ? pair.value : null;
}

export function hasClass(fig: Figure, name: string): boolean {
  return fig.attrs.some((a) => a.kind === "class" && a.value === name);
}

/** The `width` as a whole percentage, or null when unset or in another unit. */
export function widthPercent(fig: Figure): number | null {
  const m = /^(\d+(?:\.\d+)?)%$/.exec(figureAttribute(fig, "width") ?? "");
  return m ? Math.round(Number(m[1])) : null;
}

function quote(value: string): string {
  return value !== "" && /^[^\s"'{}\\]+$/.test(value) ? value : `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

function insertItem(fig: Figure, item: string, atStart = false): TextChange {
  if (!fig.block) return { from: fig.end, to: fig.end, insert: `{${item}}` };
  if (fig.attrs.length === 0) return { from: fig.block.from + 1, to: fig.block.from + 1, insert: item };
  if (atStart) return { from: fig.attrs[0].from, to: fig.attrs[0].from, insert: `${item} ` };
  const last = fig.attrs[fig.attrs.length - 1].to;
  return { from: last, to: last, insert: ` ${item}` };
}

/** Removes one item and the whitespace that separated it; the last item takes the braces along. */
function removeItem(fig: Figure, attr: FigureAttr): TextChange {
  const i = fig.attrs.indexOf(attr);
  if (fig.attrs.length === 1 && fig.block) return { from: fig.block.from, to: fig.block.to, insert: "" };
  if (i > 0) return { from: fig.attrs[i - 1].to, to: attr.to, insert: "" };
  return { from: attr.from, to: fig.attrs[1].from, insert: "" };
}

export function setCaption(fig: Figure, caption: string): TextChange[] {
  return caption === fig.caption.text ? [] : [{ from: fig.caption.from, to: fig.caption.to, insert: caption }];
}

/** Sets the `#id` (e.g. "fig:plot"); an empty id removes it. */
export function setId(fig: Figure, id: string): TextChange[] {
  const current = fig.attrs.find((a) => a.kind === "id");
  if (!current) return id ? [insertItem(fig, `#${id}`, true)] : [];
  if (!id) return [removeItem(fig, current)];
  return current.kind === "id" && current.value === id ? [] : [{ from: current.from + 1, to: current.to, insert: id }];
}

/** Sets `key=value`, quoting when needed; null removes the attribute. */
export function setAttribute(fig: Figure, key: string, value: string | null): TextChange[] {
  const pair = fig.attrs.find((a) => a.kind === "pair" && a.key === key);
  if (!pair || pair.kind !== "pair") return value === null ? [] : [insertItem(fig, `${key}=${quote(value)}`)];
  if (value === null) return [removeItem(fig, pair)];
  return value === pair.value ? [] : [{ from: pair.valueFrom, to: pair.valueTo, insert: quote(value) }];
}

export function setWidth(fig: Figure, percent: number | null): TextChange[] {
  return setAttribute(fig, "width", percent === null ? null : `${percent}%`);
}

export function setClass(fig: Figure, name: string, on: boolean): TextChange[] {
  const current = fig.attrs.find((a) => a.kind === "class" && a.value === name);
  if (on) return current ? [] : [insertItem(fig, `.${name}`)];
  return current ? [removeItem(fig, current)] : [];
}

/** `fig:<stem>` for a file stem, with `-2`, `-3`… until it is not in `taken`. */
export function uniqueFigureLabel(stem: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `fig:${stem.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "figure"}`;
  let label = base;
  for (let n = 2; used.has(label); n++) label = `${base}-${n}`;
  return label;
}

/** A name with an allowed figure extension for a pasted file, or null when it is not a figure. */
export function figureFileName(name: string, mime: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot > 0 && FIGURE_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase())) return name;
  const ext = MIME_EXTENSIONS[mime];
  if (!ext) return null;
  return `${(dot > 0 ? name.slice(0, dot) : name) || "figure"}.${ext}`;
}
