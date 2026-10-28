import type { Text } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import { skipZones } from "../spell/tokens";

/** Harper reads each skipped zone (math, a citation, code) as this word, so the sentence around it still parses. */
const PLACEHOLDER = "X";
/** How far a check reaches beyond the visible lines looking for the edges of a paragraph. */
const MAX_CONTEXT_LINES = 40;

interface Piece {
  /** Offset in the block's text. */
  at: number;
  from: number;
  to: number;
  prose: boolean;
}

/** A paragraph as Harper sees it, with the way back to document positions. */
export interface ProseBlock {
  text: string;
  pieces: Piece[];
}

/** The lines around `from`..`to` that complete the paragraphs they cut through. */
function paragraphRange(doc: Text, from: number, to: number): { from: number; to: number } {
  let first = doc.lineAt(from).number;
  let last = doc.lineAt(to).number;
  for (let n = 0; n < MAX_CONTEXT_LINES && first > 1 && /\S/.test(doc.line(first - 1).text); n++) first--;
  for (let n = 0; n < MAX_CONTEXT_LINES && last < doc.lines && /\S/.test(doc.line(last + 1).text); n++) last++;
  return { from: doc.line(first).from, to: doc.line(last).to };
}

/** The visible ranges widened to whole paragraphs, merged where they meet. */
export function proseRanges(doc: Text, ranges: readonly { from: number; to: number }[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const range of ranges) {
    const r = paragraphRange(doc, range.from, range.to);
    const last = out[out.length - 1];
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else out.push(r);
  }
  return out;
}

/** Runs of non-blank lines in `text`, as [from, to) offsets. */
function paragraphs(text: string): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  let end = 0;
  for (let pos = 0; pos <= text.length; ) {
    let eol = text.indexOf("\n", pos);
    if (eol < 0) eol = text.length;
    if (/\S/.test(text.slice(pos, eol))) {
      if (start < 0) start = pos;
      end = eol;
    } else if (start >= 0) {
      out.push([start, end]);
      start = -1;
    }
    pos = eol + 1;
  }
  if (start >= 0) out.push([start, end]);
  return out;
}

/** Skipped zones relative to `text`, clipped to it, sorted and without overlaps. */
function mergedZones(text: string, offset: number, tree: Tree): [number, number][] {
  const merged: [number, number][] = [];
  for (const [from, to] of skipZones(text, offset, tree)) {
    const f = Math.max(0, from - offset);
    const t = Math.min(text.length, to - offset);
    if (f >= t) continue;
    const last = merged[merged.length - 1];
    if (last && f <= last[1]) last[1] = Math.max(last[1], t);
    else merged.push([f, t]);
  }
  return merged;
}

/**
 * The paragraphs of `text`, a slice of the document starting at `offset` on a line boundary, with
 * math, code, citations, attributes, URLs, raw LaTeX and HTML each replaced by a placeholder word.
 * Paragraphs without any prose left are dropped.
 */
export function proseBlocks(text: string, offset: number, tree: Tree): ProseBlock[] {
  const zones = mergedZones(text, offset, tree);
  const blocks: ProseBlock[] = [];
  let z = 0;
  for (const [start, end] of paragraphs(text)) {
    const pieces: Piece[] = [];
    let built = "";
    let hasProse = false;
    const push = (from: number, to: number, prose: boolean) => {
      const slice = prose ? text.slice(from, to) : PLACEHOLDER;
      pieces.push({ at: built.length, from: offset + from, to: offset + to, prose });
      built += slice;
      hasProse ||= prose && /\p{L}/u.test(slice);
    };
    while (z < zones.length && zones[z][1] <= start) z++;
    let pos = start;
    for (let i = z; i < zones.length && zones[i][0] < end; i++) {
      const from = Math.max(zones[i][0], start);
      const to = Math.min(zones[i][1], end);
      if (from > pos) push(pos, from, true);
      push(from, to, false);
      pos = to;
    }
    if (pos < end) push(pos, end, true);
    if (hasProse) blocks.push({ text: built, pieces });
  }
  return blocks;
}

/** The document range of `start`..`end` in a block's text, or null when it reaches into a skipped zone. */
export function toDocument(block: ProseBlock, start: number, end: number): { from: number; to: number } | null {
  if (start >= end) return null;
  for (const piece of block.pieces) {
    const length = piece.prose ? piece.to - piece.from : PLACEHOLDER.length;
    if (end <= piece.at || start >= piece.at + length) continue;
    if (!piece.prose || end > piece.at + length || start < piece.at) return null;
    return { from: piece.from + start - piece.at, to: piece.from + end - piece.at };
  }
  return null;
}
