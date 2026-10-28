// Comments are Pandoc spans in the Markdown, so they travel with the text they are anchored to:
//
//   [anchored text]{.comment author="Ada" date="2026-10-28T13:00" text="The comment"}
//
// `text` holds the comment body (quotes and backslashes escaped, line breaks as spaces) and an
// optional `resolved=true` marks it done: the review PDF leaves resolved comments out, the final
// PDF never prints any. Replies are not modelled; a reply is a new comment. Every edit here is a
// local text change: wrapping inserts the brackets, attribute edits touch one value, removing
// deletes the brackets and attributes and keeps the anchored text.

import type { TextChange } from "@/editor/figureSyntax";
import type { Part } from "@/lib/api";

export const COMMENT_CLASS = "comment";

export interface AttrItem {
  kind: "id" | "class" | "pair";
  /** The item with its leading whitespace. */
  from: number;
  to: number;
  key: string;
  value: string;
  valueFrom: number;
  valueTo: number;
}

export interface Comment {
  /** `[` .. after `}`. */
  from: number;
  to: number;
  /** The anchored Markdown between the brackets. */
  textFrom: number;
  textTo: number;
  /** `{` .. after `}`. */
  attrsFrom: number;
  attrsTo: number;
  text: string;
  author: string;
  date: string;
  body: string;
  resolved: boolean;
  items: AttrItem[];
}

export interface CommentFields {
  author: string;
  date: string;
  body: string;
}

/** A quoted attribute value Pandoc reads back as `value`. */
export function quoteAttr(value: string): string {
  return `"${value.replace(/\s*\n\s*/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** "2026-10-28T13:00", in local time. */
export function commentDate(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function commentAttributes({ author, date, body }: CommentFields): string {
  return `{.${COMMENT_CLASS} author=${quoteAttr(author)} date=${quoteAttr(date)} text=${quoteAttr(body)}}`;
}

/** Wraps `from`..`to` in a comment span. */
export function wrapComment(from: number, to: number, fields: CommentFields): TextChange[] {
  return [
    { from, to: from, insert: "[" },
    { from: to, to, insert: `]${commentAttributes(fields)}` },
  ];
}

/** Drops the comment and keeps its anchored text. */
export function removeComment(c: Comment): TextChange[] {
  return [
    { from: c.from, to: c.textFrom, insert: "" },
    { from: c.textTo, to: c.to, insert: "" },
  ];
}

/** Sets (or, with null, removes) one attribute of the comment, leaving the others untouched. */
export function setCommentAttribute(c: Comment, key: string, value: string | null): TextChange[] {
  const item = c.items.find((i) => i.kind === "pair" && i.key === key);
  const written = value === "true" ? "true" : value === null ? "" : quoteAttr(value);
  if (!item) return value === null ? [] : [{ from: c.attrsTo - 1, to: c.attrsTo - 1, insert: ` ${key}=${written}` }];
  if (value === null) return [{ from: item.from, to: item.to, insert: "" }];
  return item.value === value ? [] : [{ from: item.valueFrom, to: item.valueTo, insert: written }];
}

export function setResolved(c: Comment, resolved: boolean): TextChange[] {
  return setCommentAttribute(c, "resolved", resolved ? "true" : null);
}

/** Attribute items of `{…}` from `open` (the brace); null when the braces do not close. */
export function attributeItems(text: string, open: number, base = 0): { items: AttrItem[]; end: number } | null {
  const item = /(\s*)(?:#([^\s}]+)|\.([^\s}]+)|([^\s=}"']+)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s}"']*)))/y;
  const items: AttrItem[] = [];
  let at = open + 1;
  for (;;) {
    item.lastIndex = at;
    const m = item.exec(text);
    if (!m || m[0].length === 0) break;
    if (m[0].includes("\n\n")) return null;
    const from = base + at;
    const to = from + m[0].length;
    if (m[2] !== undefined || m[3] !== undefined) {
      const value = m[2] ?? m[3];
      items.push({ kind: m[2] !== undefined ? "id" : "class", from, to, key: "", value, valueFrom: to - value.length, valueTo: to });
    } else {
      const raw = m[5] ?? m[6] ?? m[7] ?? "";
      const rawLength = m[0].length - m[1].length - m[4].length - 1;
      items.push({
        kind: "pair",
        from,
        to,
        key: m[4],
        value: m[7] !== undefined ? raw : raw.replace(/\\(.)/g, "$1"),
        valueFrom: to - rawLength,
        valueTo: to,
      });
    }
    at += m[0].length;
  }
  const close = /^\s*\}/.exec(text.slice(at, at + 64));
  return close ? { items, end: at + close[0].length } : null;
}

/** End (exclusive) of the code span opening at `start`, or the end of its backtick run when unclosed. */
function codeSpanEnd(text: string, start: number): number {
  let n = 1;
  while (text[start + n] === "`") n++;
  const run = "`".repeat(n);
  for (let at = text.indexOf(run, start + n); at >= 0; at = text.indexOf(run, at + n)) {
    if (text[at + n] !== "`" && text[at - 1] !== "`") return at + n;
  }
  return start + n;
}

/** Index of the `]` closing the `[` before `start`, within the paragraph; -1 when there is none. */
function closingBracket(text: string, start: number): number {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "`") i = codeSpanEnd(text, i) - 1;
    else if (c === "\n" && /^[ \t]*\n/.test(text.slice(i + 1, i + 80))) return -1;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  return -1;
}

/** Fenced code blocks of `text`, where brackets are not Markdown. */
function fencedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const fence = /^ {0,3}(`{3,}|~{3,})/gm;
  let open: { at: number; mark: string } | null = null;
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    if (!open) open = { at: m.index, mark: m[1] };
    else if (m[1][0] === open.mark[0] && m[1].length >= open.mark.length) {
      const end = text.indexOf("\n", m.index);
      ranges.push([open.at, end < 0 ? text.length : end]);
      open = null;
    }
  }
  if (open) ranges.push([open.at, text.length]);
  return ranges;
}

/** A bracketed span with attributes: `[text]{…}`. */
export interface ClassSpan {
  /** `[` .. after `}`. */
  from: number;
  to: number;
  /** The Markdown between the brackets. */
  textFrom: number;
  textTo: number;
  /** `{` .. after `}`. */
  attrsFrom: number;
  attrsTo: number;
  text: string;
  /** The first of `classes` the span has. */
  className: string;
  items: AttrItem[];
}

/** The value of the attribute `key` of a span, or "". */
export function pairValue(items: readonly AttrItem[], key: string): string {
  return items.find((it) => it.kind === "pair" && it.key === key)?.value ?? "";
}

/** Every span in `text` with one of `classes`, nested ones included, in document order of their `[`. */
export function parseClassSpans(text: string, classes: readonly string[], base = 0): ClassSpan[] {
  const out: ClassSpan[] = [];
  if (!classes.some((c) => text.includes(`.${c}`))) return out;
  const fences = fencedRanges(text);
  let fence = 0;
  for (let i = 0; i < text.length; i++) {
    while (fence < fences.length && fences[fence][1] <= i) fence++;
    if (fence < fences.length && fences[fence][0] <= i) {
      i = fences[fence][1];
      continue;
    }
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "`") i = codeSpanEnd(text, i) - 1;
    else if (c === "[" && text[i - 1] !== "!") {
      const close = closingBracket(text, i + 1);
      if (close < 0 || text[close + 1] !== "{") continue;
      const attrs = attributeItems(text, close + 1, base);
      const className = attrs && classes.find((c) => attrs.items.some((it) => it.kind === "class" && it.value === c));
      if (!attrs || !className) continue;
      out.push({
        from: base + i,
        to: base + attrs.end,
        textFrom: base + i + 1,
        textTo: base + close,
        attrsFrom: base + close + 1,
        attrsTo: base + attrs.end,
        text: text.slice(i + 1, close),
        className,
        items: attrs.items,
      });
    }
  }
  return out;
}

/** Every comment span in `text`, nested ones included, in document order of their `[`. */
export function parseComments(text: string, base = 0): Comment[] {
  return parseClassSpans(text, [COMMENT_CLASS], base).map((span) => ({
    ...span,
    author: pairValue(span.items, "author"),
    date: pairValue(span.items, "date"),
    body: pairValue(span.items, "text"),
    resolved: pairValue(span.items, "resolved") === "true",
  }));
}

/** The innermost comment whose span contains `pos`. */
export function commentAt(comments: readonly Comment[], pos: number): Comment | null {
  let best: Comment | null = null;
  for (const c of comments) if (c.from <= pos && pos <= c.to && (!best || c.from >= best.from)) best = c;
  return best;
}

export interface PartComment {
  file: string;
  /** 0-based line of the comment's start. */
  line: number;
  comment: Comment;
}

const partCache = new WeakMap<Part, PartComment[]>();

/** The comments of every part, in reading order; cached per part object. */
export function commentsInParts(parts: readonly Part[]): PartComment[] {
  return parts.flatMap((part) => {
    let found = partCache.get(part);
    if (!found) {
      const text = part.content;
      let line = 0;
      let lineAt = 0;
      found = parseComments(text).map((comment) => {
        for (let nl = text.indexOf("\n", lineAt); nl >= 0 && nl < comment.from; nl = text.indexOf("\n", nl + 1)) {
          line++;
          lineAt = nl + 1;
        }
        return { file: part.file, line, comment };
      });
      partCache.set(part, found);
    }
    return found;
  });
}

/** The anchored text as plain words, for lists and tooltips. */
export function plainExcerpt(markdown: string, max = 80): string {
  const plain = markdown
    .replace(/\]\{[^}]*\}/g, "]")
    .replace(/[[\]*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}
