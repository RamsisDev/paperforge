// Tracked changes are Pandoc spans in the Markdown, like comments:
//
//   [inserted text]{.insertion author="Ada" date="2026-10-28T13:00"}
//   [deleted text]{.deletion author="Ada" date="2026-10-28T13:00"}
//
// The review PDF underlines insertions and strikes deletions; the final PDF prints the text as if
// every change were accepted. Accepting an insertion or rejecting a deletion drops its brackets and
// attributes; rejecting an insertion or accepting a deletion drops the span with its text, and one
// of the two spaces that would be left side by side. `trackEdit` turns an edit made while tracking
// into the local text changes that record it.

import { COMMENT_CLASS, pairValue, parseClassSpans, quoteAttr, type ClassSpan } from "@/editor/comments/model";
import type { TextChange } from "@/editor/figureSyntax";
import { codeSpanEnd, scanInline, type Span } from "@/editor/livepreview/syntax";
import type { Part } from "@/lib/api";

export const INSERTION_CLASS = "insertion";
export const DELETION_CLASS = "deletion";
export type ChangeKind = typeof INSERTION_CLASS | typeof DELETION_CLASS;

const CHANGE_CLASSES: readonly ChangeKind[] = [INSERTION_CLASS, DELETION_CLASS];
const REVIEW_CLASSES = [INSERTION_CLASS, DELETION_CLASS, COMMENT_CLASS];

export interface Change extends Omit<ClassSpan, "className"> {
  kind: ChangeKind;
  author: string;
  date: string;
}

export interface ChangeFields {
  author: string;
  date: string;
}

export function changeAttributes(kind: ChangeKind, { author, date }: ChangeFields): string {
  return `{.${kind} author=${quoteAttr(author)} date=${quoteAttr(date)}}`;
}

function toChange({ className, ...span }: ClassSpan): Change {
  return { ...span, kind: className as ChangeKind, author: pairValue(span.items, "author"), date: pairValue(span.items, "date") };
}

/** Every insertion and deletion in `text`, nested ones included, in document order of their `[`. */
export function parseChanges(text: string, base = 0): Change[] {
  return parseClassSpans(text, CHANGE_CLASSES, base).map(toChange);
}

/** The innermost change whose span contains `pos`. */
export function changeAt(changes: readonly Change[], pos: number): Change | null {
  let best: Change | null = null;
  for (const c of changes) if (c.from <= pos && pos <= c.to && (!best || c.from >= best.from)) best = c;
  return best;
}

/** A character of the document, "" outside it. */
export type CharAt = (pos: number) => string;

const isBlank = (c: string) => c === " " || c === "\t";
const isEdge = (c: string) => c === "" || c === "\n";

/** Deletes `from`..`to` with one of the spaces it would leave doubled, or the line break of a line it empties. */
function removal(from: number, to: number, charAt: CharAt): TextChange {
  const before = charAt(from - 1);
  const after = charAt(to);
  if (isBlank(after) && (isBlank(before) || isEdge(before))) return { from, to: to + 1, insert: "" };
  if (isBlank(before) && isEdge(after)) return { from: from - 1, to, insert: "" };
  if (after === "\n" && isEdge(before)) return { from, to: to + 1, insert: "" };
  if (after === "" && before === "\n") return { from: from - 1, to, insert: "" };
  return { from, to, insert: "" };
}

function unwrap(c: Change): TextChange[] {
  return [
    { from: c.from, to: c.textFrom, insert: "" },
    { from: c.textTo, to: c.to, insert: "" },
  ];
}

function resolution(c: Change, accept: boolean, charAt: CharAt): TextChange[] {
  const keepsText = (c.kind === INSERTION_CLASS) === accept;
  return keepsText ? unwrap(c) : [removal(c.from, c.to, charAt)];
}

/**
 * Accepts (or rejects) `changes` at once. Every resolution only deletes text, so nested changes
 * merge into the deletions of the changes around them.
 */
export function resolveChanges(changes: readonly Change[], accept: boolean, charAt: CharAt): TextChange[] {
  const ranges = changes
    .flatMap((c) => resolution(c, accept, charAt))
    .filter((r) => r.from < r.to)
    .sort((a, b) => a.from - b.from);
  const out: TextChange[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}

export interface PartChange {
  file: string;
  /** 0-based line of the change's start. */
  line: number;
  change: Change;
}

const partCache = new WeakMap<Part, PartChange[]>();

/** The changes of every part, in reading order; cached per part object. */
export function changesInParts(parts: readonly Part[]): PartChange[] {
  return parts.flatMap((part) => {
    let found = partCache.get(part);
    if (!found) {
      const text = part.content;
      let line = 0;
      let lineAt = 0;
      found = parseChanges(text).map((change) => {
        for (let nl = text.indexOf("\n", lineAt); nl >= 0 && nl < change.from; nl = text.indexOf("\n", nl + 1)) {
          line++;
          lineAt = nl + 1;
        }
        return { file: part.file, line, change };
      });
      partCache.set(part, found);
    }
    return found;
  });
}

// Recording edits ----------------------------------------------------------------------------

/** How the edit was made: typed (or pasted), a backspace, a forward delete or a selection cut. */
export type EditKind = "type" | "backward" | "forward" | "selection";

export interface TrackedEdit {
  /** The edit as made, in document offsets. */
  from: number;
  to: number;
  insert: string;
  kind: EditKind;
  /** Where the cursor ended up within `insert`; its end when omitted. */
  caret?: number;
}

export interface TrackContext extends ChangeFields {
  /** Whole paragraphs around the edit, starting at document offset `base`. */
  text: string;
  base: number;
}

/**
 * The changes that record the edit and the cursor after them; "untracked" to let the edit through
 * as made (it is not prose: math, code, attributes, a line break…), "blocked" to drop it (it would
 * cut through the brackets of a change or comment).
 */
export type TrackResult = { changes: TextChange[]; cursor: number } | "untracked" | "blocked";

/** Markup a change may hold whole but never split: math, citations, attributes, code, raw LaTeX. */
function markupAtoms(text: string, base: number, spans: readonly ClassSpan[]): Span[] {
  const reviewAttrs = new Set(spans.map((s) => s.attrsFrom));
  const atoms: Span[] = scanInline(text, base).filter((t) => !(t.kind === "attr" && reviewAttrs.has(t.from)));
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "`") {
      const end = codeSpanEnd(text, i);
      let n = 1;
      while (text[i + n] === "`") n++;
      if (end > i + n) atoms.push({ from: base + i, to: base + end });
      i = end - 1;
    }
  }
  return atoms;
}

function balanced(text: string): boolean {
  let square = 0;
  let curly = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "[") square++;
    else if (c === "]" && --square < 0) return false;
    else if (c === "{") curly++;
    else if (c === "}" && --curly < 0) return false;
  }
  return square === 0 && curly === 0;
}

/** A change being built; `pieces` are its text changes in the order they were added. */
type Cursor = { pos: number } | { piece: TextChange; offset: number };

/**
 * Sorts and merges the pieces (inserts at one position keep their order) and places the cursor:
 * at a piece's offset, or at an old position no piece starts at or covers.
 */
function finish(pieces: TextChange[], cursor: Cursor): { changes: TextChange[]; cursor: number } {
  const order = pieces.map((piece, i) => ({ piece, i })).sort((x, y) => x.piece.from - y.piece.from || x.i - y.i);
  const merged: { change: TextChange; offsets: Map<TextChange, number> }[] = [];
  for (const { piece } of order) {
    const last = merged[merged.length - 1];
    if (last && piece.from <= last.change.to) {
      last.offsets.set(piece, last.change.insert.length);
      last.change.to = Math.max(last.change.to, piece.to);
      last.change.insert += piece.insert;
    } else {
      merged.push({ change: { ...piece }, offsets: new Map([[piece, 0]]) });
    }
  }
  let delta = 0;
  let pos = "pos" in cursor ? cursor.pos : 0;
  for (const { change, offsets } of merged) {
    if ("piece" in cursor) {
      const offset = offsets.get(cursor.piece);
      if (offset !== undefined) pos = change.from + delta + offset + cursor.offset;
    } else if (change.from < cursor.pos && change.to <= cursor.pos) {
      pos += change.insert.length - (change.to - change.from);
    }
    delta += change.insert.length - (change.to - change.from);
  }
  return { changes: merged.map((m) => m.change), cursor: pos };
}

/** Records `edit` as tracked changes by `ctx.author`, in the paragraphs of `ctx`. */
export function trackEdit(edit: TrackedEdit, ctx: TrackContext): TrackResult {
  const { text, base } = ctx;
  const end = base + text.length;
  if (edit.from < base || edit.to > end) return "untracked";
  const charAt: CharAt = (pos) => (pos >= base && pos < end ? text[pos - base] : "");
  const slice = (from: number, to: number) => text.slice(from - base, to - base);
  if (edit.insert.includes("\n") || slice(edit.from, edit.to).includes("\n")) return "untracked";

  const spans = parseClassSpans(text, REVIEW_CLASSES, base);
  const atoms = markupAtoms(text, base, spans);
  const own = (s: ClassSpan, kind: ChangeKind) => s.className === kind && pairValue(s.items, "author") === ctx.author;
  const innermostChange = (from: number, to: number) => {
    let best: ClassSpan | null = null;
    for (const s of spans) {
      if (s.className !== COMMENT_CLASS && s.textFrom <= from && to <= s.textTo && (!best || s.from >= best.from)) best = s;
    }
    return best;
  };
  const splitsAtom = (from: number, to: number) =>
    atoms.some((t) => (from === to ? t.from < from && from < t.to : from < t.to && to > t.from && !(from <= t.from && to >= t.to)));
  const inSyntax = (pos: number) => spans.some((s) => s.textTo < pos && pos < s.to);
  const crossesSpan = (from: number, to: number) =>
    spans.some((s) => from < s.to && to > s.from && !(from >= s.textFrom && to <= s.textTo) && !(from <= s.from && to >= s.to));
  const opensMarkup = (pos: number) => /[!^]/.test(charAt(pos - 1)) && charAt(pos - 2) !== "\\";

  let { from: a, to: b } = edit;
  const width = b - a;
  // Backspace and Delete next to brackets act on the text inside them, and skip deleted text.
  if (edit.kind === "backward") {
    for (let n = 0, at = b; n < 8; n++) {
      const closing = spans.find((s) => s.to === at);
      const opening = spans.find((s) => s.textFrom === at);
      if (closing) at = closing.className === DELETION_CLASS ? closing.from : closing.textTo;
      else if (opening) at = opening.from;
      else break;
      [a, b] = [at - width, at];
    }
  } else if (edit.kind === "forward") {
    for (let n = 0, at = a; n < 8; n++) {
      const opening = spans.find((s) => s.from === at);
      const closing = spans.find((s) => s.textTo === at);
      if (opening) at = opening.className === DELETION_CLASS ? opening.to : opening.textFrom;
      else if (closing) at = closing.to;
      else break;
      [a, b] = [at, at + width];
    }
  }
  if (a < base || b > end || slice(a, b).includes("\n")) return "untracked";

  const pieces: TextChange[] = [];
  const add = (from: number, to: number, insert: string) => {
    const piece = { from, to, insert };
    pieces.push(piece);
    return piece;
  };
  let cursor: Cursor = { pos: edit.kind === "backward" ? a : b };
  /** Where typed text goes; after the deletion that replaces a selection. */
  let at = a;
  /** Own insertions the deletion removed: no longer there to extend. */
  const removed = new Set<ClassSpan>();

  if (a < b) {
    if (splitsAtom(a, b)) return "untracked";
    if (crossesSpan(a, b)) return "blocked";
    const inner = innermostChange(a, b);
    if (inner?.className === DELETION_CLASS) {
      at = inner.to;
    } else if (inner && own(inner, INSERTION_CLASS)) {
      if (a === inner.textFrom && b === inner.textTo && !edit.insert) {
        return finish([{ from: inner.from, to: inner.to, insert: "" }], { pos: inner.from });
      }
      const piece = add(a, b, edit.insert);
      return finish(pieces, { piece, offset: edit.caret ?? edit.insert.length });
    } else {
      const mine = spans.filter((s) => own(s, INSERTION_CLASS) && a <= s.from && s.to <= b);
      for (const s of mine) {
        add(s.from, s.to, "");
        removed.add(s);
      }
      const kept = mine.reduce((n, s) => n - (s.to - s.from), b - a);
      if (kept > 0) {
        const left = spans.find((s) => own(s, DELETION_CLASS) && s.to === a);
        const right = spans.find((s) => own(s, DELETION_CLASS) && s.from === b);
        if (!left && opensMarkup(a)) return "untracked";
        const open = left ? add(left.textTo, left.to, "") : add(a, a, "[");
        const close = right
          ? add(right.from, right.textFrom, "")
          : add(b, b, left ? slice(left.textTo, left.to) : `]${changeAttributes(DELETION_CLASS, ctx)}`);
        const start: Cursor = left ? { pos: left.from } : { piece: open, offset: 0 };
        const after: Cursor = right ? { pos: right.to } : { piece: close, offset: close.insert.length };
        cursor = edit.kind === "backward" ? start : after;
        at = right ? right.to : b;
      }
    }
  }
  if (!edit.insert) return finish(pieces, cursor);

  const refuse = (): TrackResult => (pieces.length || spans.some((s) => s.textFrom <= at && at <= s.textTo) ? "blocked" : "untracked");
  if (!balanced(edit.insert)) return refuse();
  for (let n = 0; n < 8; n++) {
    const inner = innermostChange(at, at);
    if (inner?.className !== DELETION_CLASS) break;
    at = at === inner.textFrom && a === b ? inner.from : inner.to;
  }
  if (inSyntax(at) || splitsAtom(at, at)) return refuse();
  const caret = edit.caret ?? edit.insert.length;
  const inner = innermostChange(at, at);
  if (inner && own(inner, INSERTION_CLASS) && !removed.has(inner)) {
    return finish(pieces, { piece: add(at, at, edit.insert), offset: caret });
  }
  const before = spans.find((s) => own(s, INSERTION_CLASS) && !removed.has(s) && s.to === at);
  const after = spans.find((s) => own(s, INSERTION_CLASS) && !removed.has(s) && s.from === at);
  const next = before ?? after;
  if (next) {
    const pos = before ? next.textTo : next.textFrom;
    return finish(pieces, { piece: add(pos, pos, edit.insert), offset: caret });
  }
  const closesDeletion = pieces.some((p) => p.from === at && p.insert.startsWith("]"));
  if (!closesDeletion && opensMarkup(at)) return refuse();
  const piece = add(at, at, `[${edit.insert}]${changeAttributes(INSERTION_CLASS, ctx)}`);
  return finish(pieces, { piece, offset: 1 + caret });
}
