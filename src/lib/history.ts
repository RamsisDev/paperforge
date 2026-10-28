// Pure helpers of the History panel and the compare view: dates, the timeline and word diffs.

import type { DiffSegment, VersionInfo } from "./api";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `VersionInfo.time` (Unix seconds) as a Date. */
export function versionDate(version: Pick<VersionInfo, "time">): Date {
  return new Date(version.time * 1000);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "14:02". */
export function clockLabel(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "28 Oct", with the year when it is not the year of `now`. */
export function dateLabel(date: Date, now: Date = new Date()): string {
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? day : `${day} ${date.getFullYear()}`;
}

/** "Today", "Yesterday" or "28 Oct". */
export function dayLabel(date: Date, now: Date = new Date()): string {
  if (sameDay(date, now)) return "Today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return sameDay(date, yesterday) ? "Yesterday" : dateLabel(date, now);
}

/** "14:02" today, else "28 Oct 14:02". */
export function whenLabel(date: Date, now: Date = new Date()): string {
  return sameDay(date, now) ? clockLabel(date) : `${dateLabel(date, now)} ${clockLabel(date)}`;
}

/** The summary of the version recorded when a project closes: "Session 28 Oct 10:02–12:30". */
export function sessionLabel(start: Date, end: Date, now: Date = new Date()): string {
  const to = sameDay(start, end) ? clockLabel(end) : `${dateLabel(end, now)} ${clockLabel(end)}`;
  return `Session ${dateLabel(start, now)} ${clockLabel(start)}–${to}`;
}

export type TimelineEntry =
  | { kind: "version" | "autosave"; version: VersionInfo }
  /** Consecutive autosaves, newest first. */
  | { kind: "autosaves"; versions: VersionInfo[] };

export interface TimelineDay {
  label: string;
  entries: TimelineEntry[];
}

/**
 * Groups snapshots (newest first) by day, folding runs of at least `minFold` consecutive
 * autosaves of the same day into one entry.
 */
export function timeline(versions: VersionInfo[], now: Date = new Date(), minFold = 2): TimelineDay[] {
  const days: TimelineDay[] = [];
  let run: VersionInfo[] = [];
  const flush = () => {
    const day = days.at(-1);
    if (!day || run.length === 0) return;
    if (run.length >= minFold) day.entries.push({ kind: "autosaves", versions: run });
    else for (const version of run) day.entries.push({ kind: "autosave", version });
    run = [];
  };
  for (const version of versions) {
    const label = dayLabel(versionDate(version), now);
    if (days.at(-1)?.label !== label) {
      flush();
      days.push({ label, entries: [] });
    }
    if (version.kind === "autosave") run.push(version);
    else {
      flush();
      days.at(-1)!.entries.push({ kind: "version", version });
    }
  }
  flush();
  return days;
}

/** A run of the compare view: a diff segment, or unchanged text folded away. */
export type ShownSegment = DiffSegment | { kind: "fold"; text: string; words: number };

const TOKENS = /\s+|\S+/g;

function isWord(token: string): boolean {
  return !/^\s/.test(token);
}

function countWords(tokens: string[]): number {
  return tokens.filter(isWord).length;
}

/** How many tokens from the start of `tokens` make up `words` words, stopping at a line break. */
function contextLength(tokens: string[], words: number): number {
  let end = 0;
  let seen = 0;
  for (let i = 0; i < tokens.length && seen < words; i++) {
    if (isWord(tokens[i])) {
      seen++;
      end = i + 1;
    } else if (tokens[i].includes("\n")) break;
  }
  return end;
}

/**
 * Folds unchanged runs longer than `context` words on each side of a change (and at least
 * `minFold` hidden words), keeping the context next to the changes within its paragraph.
 */
export function foldSegments(segments: DiffSegment[], context = 8, minFold = 12): ShownSegment[] {
  const out: ShownSegment[] = [];
  segments.forEach((segment, i) => {
    if (segment.kind !== "equal") {
      out.push(segment);
      return;
    }
    const tokens = segment.text.match(TOKENS) ?? [];
    const breakAt = (k: number) => k >= 0 && k < tokens.length && !isWord(tokens[k]) && tokens[k].includes("\n");
    let lead = i > 0 ? contextLength(tokens, context) : 0;
    let trail = i < segments.length - 1 ? contextLength([...tokens].reverse(), context) : 0;
    // Line breaks next to the context stay visible, so a fold sits between paragraphs.
    if (breakAt(lead)) lead++;
    if (tokens.length - trail - 1 >= lead && breakAt(tokens.length - trail - 1)) trail++;
    const hidden = tokens.slice(lead, Math.max(lead, tokens.length - trail));
    if (countWords(hidden) < minFold) {
      out.push(segment);
      return;
    }
    const before = tokens.slice(0, lead).join("");
    const after = tokens.slice(tokens.length - trail).join("");
    if (before) out.push({ kind: "equal", text: before });
    out.push({ kind: "fold", text: hidden.join(""), words: countWords(hidden) });
    if (after) out.push({ kind: "equal", text: after });
  });
  return out;
}

/** The first `words` words of `text` and how many words follow them. */
export function headWords(text: string, words: number): { head: string; rest: number } {
  const tokens = text.match(TOKENS) ?? [];
  const n = contextLength(tokens.map((t) => t.replace(/\n/g, " ")), words);
  return { head: tokens.slice(0, n).join(""), rest: countWords(tokens.slice(n)) };
}
