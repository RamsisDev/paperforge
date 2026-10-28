// Pandoc syntax that the Markdown grammar reads as plain paragraph text: math, citations,
// cross references, footnotes, attribute blocks, divs and raw LaTeX. Pure functions over strings;
// every offset is absolute (`base` + index).

import type { BibEntry } from "@/lib/bib";
import { shortAuthors } from "@/lib/bib";
import type { LabelRef } from "@/lib/api";
import { refKind, refName } from "@/lib/refnames";

export interface Span {
  from: number;
  to: number;
}

export interface Attributes {
  id: string;
  classes: string[];
  pairs: Record<string, string>;
}

export interface CiteItem {
  key: string;
  /** Text after the key inside a bracketed citation, such as "p. 3". */
  locator: string;
}

export type InlineToken = Span &
  (
    | { kind: "math"; display: boolean; tex: string; label: string }
    | { kind: "cite"; bracketed: boolean; items: CiteItem[] }
    | { kind: "ref"; id: string }
    | { kind: "footnote"; text: string }
    | { kind: "footnoteRef"; id: string }
    | { kind: "attr"; attrs: Attributes }
    | { kind: "rawInline"; format: string; code: Span; open: Span; close: Span }
  );

export type InlineKind = InlineToken["kind"];

const KEY = /^@(\w(?:[\w:.#$%&+?<>~/-]*\w)?)/;

/** `{#id .class key=value key2="quoted value"}` without the braces. */
export function parseAttributes(inner: string): Attributes {
  const attrs: Attributes = { id: "", classes: [], pairs: {} };
  const item = /\s*(?:#([^\s}]+)|\.([^\s}]+)|([^\s=}]+)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S*)))/gy;
  for (let m = item.exec(inner); m; m = item.exec(inner)) {
    if (m[1] !== undefined) attrs.id = m[1];
    else if (m[2] !== undefined) attrs.classes.push(m[2]);
    else attrs.pairs[m[3]] = (m[4] ?? m[5] ?? m[6] ?? "").replace(/\\(.)/g, "$1");
  }
  return attrs;
}

/** Index of the `]` closing a `[` opened before `start`, or -1; stays on one paragraph. */
function closingBracket(text: string, start: number): number {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "`") i = codeSpanEnd(text, i) - 1;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  return -1;
}

/** End (exclusive) of the code span opening at `start`, or the end of its backtick run when unclosed. */
export function codeSpanEnd(text: string, start: number): number {
  let n = 1;
  while (text[start + n] === "`") n++;
  const run = "`".repeat(n);
  for (let at = text.indexOf(run, start + n); at >= 0; at = text.indexOf(run, at + n)) {
    if (text[at + n] !== "`" && text[at - 1] !== "`") return at + n;
  }
  return start + n;
}

/** The items of `[see @a, p. 3; @b]`, or null when the brackets hold no citation. */
export function parseCitation(inner: string): CiteItem[] | null {
  const items: CiteItem[] = [];
  for (const part of inner.split(";")) {
    const at = /(^|[\s-])@/.exec(part);
    if (!at) return null;
    const key = KEY.exec(part.slice(at.index + at[1].length));
    if (!key) return null;
    const rest = part.slice(at.index + at[1].length + key[0].length);
    items.push({ key: key[1], locator: rest.replace(/^\s*,?\s*/, "").trim() });
  }
  return items.length ? items : null;
}

function inlineMathEnd(text: string, start: number): number {
  const next = text[start + 1];
  if (next === undefined || /\s/.test(next)) return -1;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "\n") return -1;
    else if (c === "$" && !/\s/.test(text[i - 1]) && !/\d/.test(text[i + 1] ?? "")) return i;
  }
  return -1;
}

/** Index of the `}` closing the attributes opened at `start`, past quoted values; -1 past the line. */
function attributesEnd(text: string, start: number): number {
  let quote = "";
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") return -1;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if ((c === '"' || c === "'") && text[i - 1] === "=") quote = c;
    else if (c === "}") return i;
  }
  return -1;
}

function displayMathEnd(text: string, start: number): number {
  for (let i = start + 2; i < text.length - 1; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "$" && text[i + 1] === "$") return i;
  }
  return -1;
}

/**
 * Pandoc constructs in a run of paragraph text, in order and without overlaps. Code spans are
 * skipped (except `` `…`{=latex} ``), as are escaped characters.
 */
export function scanInline(text: string, base = 0): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      const end = codeSpanEnd(text, i);
      let n = 1;
      while (text[i + n] === "`") n++;
      const raw = end > i + n ? /^\{=([\w-]+)\}/.exec(text.slice(end)) : null;
      if (raw) {
        tokens.push({
          kind: "rawInline",
          format: raw[1],
          from: base + i,
          to: base + end + raw[0].length,
          open: { from: base + i, to: base + i + n },
          code: { from: base + i + n, to: base + end - n },
          close: { from: base + end - n, to: base + end + raw[0].length },
        });
        i = end + raw[0].length;
      } else i = end;
      continue;
    }
    if (c === "$" && text[i + 1] === "$") {
      const end = displayMathEnd(text, i);
      if (end > i + 2) {
        const label = /^[ \t]*\{#([^\s}]+)[^}\n]*\}/.exec(text.slice(end + 2));
        tokens.push({
          kind: "math",
          display: true,
          tex: text.slice(i + 2, end).trim(),
          label: label?.[1] ?? "",
          from: base + i,
          to: base + end + 2 + (label?.[0].length ?? 0),
        });
        i = end + 2 + (label?.[0].length ?? 0);
        continue;
      }
      i += 2;
      continue;
    }
    if (c === "$") {
      const end = inlineMathEnd(text, i);
      if (end > i + 1) {
        tokens.push({ kind: "math", display: false, tex: text.slice(i + 1, end), label: "", from: base + i, to: base + end + 1 });
        i = end + 1;
        continue;
      }
      i++;
      continue;
    }
    if (c === "^" && text[i + 1] === "[") {
      const end = closingBracket(text, i + 2);
      if (end > 0) {
        tokens.push({ kind: "footnote", text: text.slice(i + 2, end).trim(), from: base + i, to: base + end + 1 });
        i = end + 1;
        continue;
      }
    }
    if (c === "[") {
      const note = /^\[\^([^\]\s]+)\]/.exec(text.slice(i));
      if (note) {
        if (text[i + note[0].length] !== ":") {
          tokens.push({ kind: "footnoteRef", id: note[1], from: base + i, to: base + i + note[0].length });
        }
        i += note[0].length;
        continue;
      }
      const end = closingBracket(text, i + 1);
      const items = end > 0 && !/^[({[]/.test(text[end + 1] ?? "") ? parseCitation(text.slice(i + 1, end)) : null;
      if (items) {
        tokens.push({ kind: "cite", bracketed: true, items, from: base + i, to: base + end + 1 });
        i = end + 1;
        continue;
      }
      i++;
      continue;
    }
    if (c === "@" && !/[\w\\]/.test(text[i - 1] ?? "")) {
      const key = KEY.exec(text.slice(i));
      if (key) {
        const to = base + i + key[0].length;
        tokens.push(
          refKind(key[1])
            ? { kind: "ref", id: key[1], from: base + i, to }
            : { kind: "cite", bracketed: false, items: [{ key: key[1], locator: "" }], from: base + i, to },
        );
        i += key[0].length;
        continue;
      }
    }
    if (c === "{" && (text[i + 1] === "#" || text[i + 1] === ".")) {
      const end = attributesEnd(text, i);
      if (end > 0) {
        tokens.push({ kind: "attr", attrs: parseAttributes(text.slice(i + 1, end)), from: base + i, to: base + end + 1 });
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return tokens;
}

/** A `:::` div fence line: the opening one names its class or id, the closing one has no label. */
export function divFence(line: string): { open: boolean; label: string } | null {
  const m = /^ {0,3}:{3,}[ \t]*(.*?)[ \t]*:*[ \t]*$/.exec(line);
  if (!m) return null;
  const rest = m[1];
  if (!rest) return { open: false, label: "" };
  if (rest.startsWith("{")) {
    const attrs = parseAttributes(rest.replace(/^\{|\}$/g, ""));
    return { open: true, label: attrs.classes.join(" ") || (attrs.id && `#${attrs.id}`) || "div" };
  }
  return /^[\w-]+$/.test(rest) ? { open: true, label: rest } : null;
}

/** The format of a fenced block's info string `{=latex}`, or null for ordinary code. */
export function rawFormat(info: string): string | null {
  return /^\{=([\w-]+)\}$/.exec(info.trim())?.[1] ?? null;
}

/** "Shannon 1948", or the key when refs.bib does not have it. */
export function citationText(item: CiteItem, entry: BibEntry | undefined): string {
  const name = entry ? [shortAuthors(entry.author) || entry.key, entry.year].filter(Boolean).join(" ") : `@${item.key}`;
  return item.locator ? `${name}, ${item.locator}` : name;
}

/**
 * What a reference chip shows: the number alone after a word that already names the kind
 * ("Figure @fig:x" prints "Figure 2"), the name and number otherwise, and only the name (or "?"
 * after the name) until a compile has numbered the label.
 */
export function referenceText(id: string, ref: LabelRef | undefined, language: string | undefined, before: string): string {
  const kind = refKind(id);
  if (!kind) return `@${id}`;
  const name = refName(kind, language);
  const named = new RegExp(`(?:^|[^\\p{L}])${name}[\\s~\\u00a0]*$`, "iu").test(before);
  const number = ref?.number;
  if (named) return number || "?";
  return number ? `${name} ${number}` : name;
}

/** A figure caption without inline Markdown marks, for the caption under a thumbnail. */
export function plainCaption(caption: string): string {
  return caption
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

/** The cursor's and selection's lines, merged: decorations touching them show their source. */
export function activeSpans(ranges: readonly Span[], line: (pos: number) => Span): Span[] {
  const spans = ranges.map((r) => ({ from: line(r.from).from, to: line(r.to).to })).sort((a, b) => a.from - b.from);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.from <= last.to + 1) last.to = Math.max(last.to, s.to);
    else merged.push({ ...s });
  }
  return merged;
}

/** Whether `from`..`to` touches one of the (sorted) active spans, ends included. */
export function touchesActive(from: number, to: number, spans: readonly Span[]): boolean {
  for (const s of spans) {
    if (s.from > to) return false;
    if (s.to >= from) return true;
  }
  return false;
}

/**
 * Grows `from`..`to` until it holds whole blocks: `extents` returns the spans (syntax blocks and
 * existing decorations) that touch a range. Rebuilding exactly that range never leaves half a block.
 */
export function expandRegion(from: number, to: number, extents: (from: number, to: number) => Iterable<Span>): Span {
  for (let round = 0; round < 8; round++) {
    let a = from;
    let b = to;
    for (const s of extents(from, to)) {
      a = Math.min(a, s.from);
      b = Math.max(b, s.to);
    }
    if (a === from && b === to) break;
    from = a;
    to = b;
  }
  return { from, to };
}
