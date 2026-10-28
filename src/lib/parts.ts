import type { Part } from "./api";
import { headings, wordCount, type Heading } from "./outline";
import { bestLine, words } from "./textmatch";

export interface PartLine {
  file: string;
  /** 0-based line in that part. */
  line: number;
}

export interface PartInfo {
  headings: Heading[];
  words: number;
  /** Headings per level, index 1..6. */
  levels: number[];
}

/** The whole document as one Markdown text, in reading order. */
export function allText(parts: Part[]): string {
  return parts.map((p) => p.content).join("\n\n");
}

export function partStem(file: string): string {
  return (file.split("/").pop() ?? file).replace(/\.md$/i, "");
}

/** First heading of a part, without scanning past it; the file stem when there is none. */
export function partTitle(part: Part): string {
  let fence: string | null = null;
  let from = 0;
  const text = part.content;
  while (from <= text.length) {
    let to = text.indexOf("\n", from);
    if (to < 0) to = text.length;
    const raw = text.slice(from, to);
    const fenceMatch = /^\s*(```|~~~)/.exec(raw);
    if (fenceMatch) fence = fence === null ? fenceMatch[1] : fence === fenceMatch[1] ? null : fence;
    else if (!fence) {
      const m = /^#{1,6}\s+(.*?)\s*$/.exec(raw);
      if (m) {
        const title = m[1].replace(/\s*\{[^}]*\}\s*$/, "");
        if (title) return title;
      }
    }
    from = to + 1;
  }
  return partStem(part.file);
}

const infoCache = new WeakMap<Part, PartInfo>();

/** Headings and counts of one part; cached per part object, so only edited parts are rescanned. */
export function partInfo(part: Part): PartInfo {
  let info = infoCache.get(part);
  if (!info) {
    const hs = headings(part.content);
    const levels = [0, 0, 0, 0, 0, 0, 0];
    for (const h of hs) levels[h.level]++;
    info = { headings: hs, words: wordCount(part.content), levels };
    infoCache.set(part, info);
  }
  return info;
}

export function totalWords(parts: Part[]): number {
  return parts.reduce((sum, p) => sum + partInfo(p).words, 0);
}

export const LONG_PART_WORDS = 2500;

/**
 * The heading level a part splits at, or null when it has fewer than two headings of that level.
 * Level 1 is preferred: it turns one part into one part per `#` chapter/section.
 */
export function splitLevel(part: Part): 1 | 2 | null {
  const { levels } = partInfo(part);
  return levels[1] >= 2 ? 1 : levels[2] >= 2 ? 2 : null;
}

/** Whether to suggest splitting: long, or several top-level headings in one file. */
export function isLongPart(part: Part): boolean {
  const info = partInfo(part);
  return (info.words > LONG_PART_WORDS || info.levels[1] >= 3) && splitLevel(part) !== null;
}

/** The best-matching line for `needle` in any part; parts are searched independently. */
export function bestLineInParts(needle: string, parts: Part[], focus?: string): (PartLine & { score: number }) | null {
  let best: (PartLine & { score: number }) | null = null;
  for (const part of parts) {
    const match = bestLine(needle, part.content.split("\n"), focus);
    if (match && (!best || match.score > best.score)) best = { file: part.file, line: match.line, score: match.score };
  }
  return best;
}

/** First line, in reading order, that contains `text` literally. */
export function findInParts(parts: Part[], text: string): PartLine | null {
  for (const part of parts) {
    const at = part.content.split("\n").findIndex((l) => l.includes(text));
    if (at >= 0) return { file: part.file, line: at };
  }
  return null;
}

/** The heading whose text is `title` (as LaTeX printed it), falling back to the closest one. */
export function findHeading(parts: Part[], title: string): PartLine | null {
  const all = parts.flatMap((p) => partInfo(p).headings.map((h) => ({ file: p.file, line: h.line, text: h.text })));
  const key = words(title).join(" ");
  const exact = all.find((h) => words(h.text).join(" ") === key);
  if (exact) return { file: exact.file, line: exact.line };
  const match = bestLine(title, all.map((h) => h.text));
  return match ? { file: all[match.line].file, line: all[match.line].line } : null;
}
