// Line arithmetic for "Show LaTeX" and the "LaTeX (generated)" tab. The generated view is the
// backend's `flatten_tex`: each fragment sits between a `%PF-PART:<part>` and a `%PF-PART-END`
// line, and each top-level block of the part starts with a `%PF:N` line (N = its first Markdown
// line) followed by a blank line.

import type { BlockLatex, SourceSpot } from "@/lib/api";

export const PART_START = "%PF-PART:";
export const PART_END = "%PF-PART-END";
const MARKER = /^%PF:(\d+)\s*$/;

/** The part of a CodeMirror `Text` these functions read. */
export interface Lines {
  readonly lines: number;
  line(n: number): { text: string };
}

function markerAt(doc: Lines, n: number): number | null {
  const m = MARKER.exec(doc.line(n).text.trim());
  return m ? Number(m[1]) : null;
}

function isEnd(doc: Lines, n: number): boolean {
  return doc.line(n).text.trim() === PART_END;
}

/** The last line of the block whose marker is on line `marker`, blank lines excluded. */
function blockEnd(doc: Lines, marker: number): number {
  let end = marker + 1;
  while (end < doc.lines && !isEnd(doc, end + 1) && markerAt(doc, end + 1) === null) end++;
  while (end > marker + 2 && !doc.line(end).text.trim()) end--;
  return end;
}

/** The Markdown part and line (1-based) a line of the generated view came from. */
export function generatedSpot(doc: Lines, line: number): SourceSpot | null {
  let marker: { at: number; n: number } | null = null;
  for (let k = Math.min(line, doc.lines); k >= 1; k--) {
    const text = doc.line(k).text.trim();
    if (text === PART_END) return null;
    if (text.startsWith(PART_START)) {
      const part = text.slice(PART_START.length);
      if (!marker) return { part, line: 1 };
      const offset = Math.max(0, line - (marker.at + 2));
      let next: number | null = null;
      for (let j = marker.at + 1; j <= doc.lines && next === null && !isEnd(doc, j); j++) next = markerAt(doc, j);
      const last = next === null ? Infinity : Math.max(marker.n, next - 1);
      return { part, line: Math.min(marker.n + offset, last) };
    }
    if (!marker) {
      const n = markerAt(doc, k);
      if (n !== null) marker = { at: k, n };
    }
  }
  return null;
}

/**
 * Where a Markdown line of a part is in the generated view: the `%PF:N` line of its block and the
 * line at the same offset inside the block. Null when the part is not in the view.
 */
export function generatedLine(doc: Lines, part: string, markdownLine: number): { marker: number; line: number } | null {
  const start = `${PART_START}${part}`;
  let k = 1;
  while (k <= doc.lines && doc.line(k).text.trim() !== start) k++;
  if (k > doc.lines) return null;
  let best: { at: number; n: number } | null = null;
  for (let j = k + 1; j <= doc.lines && !isEnd(doc, j); j++) {
    const n = markerAt(doc, j);
    if (n === null) continue;
    if (n > markdownLine) break;
    best = { at: j, n };
  }
  if (!best) return { marker: k, line: Math.min(k + 1, doc.lines) };
  const end = blockEnd(doc, best.at);
  const line = Math.min(best.at + 2 + (markdownLine - best.n), end);
  return { marker: best.at, line: Math.max(line, Math.min(best.at + 2, end)) };
}

/** A fence no line of `latex` can close. */
function fenceFor(latex: string): string {
  let longest = 0;
  for (const line of latex.split("\n")) longest = Math.max(longest, /^\s*(`*)/.exec(line)![1].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** The change that replaces the block's Markdown lines with its LaTeX as a raw LaTeX block. */
export function rawLatexChange(
  doc: { lines: number; line(n: number): { from: number; to: number } },
  block: Pick<BlockLatex, "markdownFrom" | "markdownTo" | "latex">,
): { from: number; to: number; insert: string } {
  const from = doc.line(Math.min(block.markdownFrom, doc.lines)).from;
  const to = doc.line(Math.min(Math.max(block.markdownTo, block.markdownFrom), doc.lines)).to;
  const fence = fenceFor(block.latex);
  return { from, to, insert: `${fence}{=latex}\n${block.latex}\n${fence}` };
}
