import type { TemplateId } from "./api";
import { usesChapters } from "./templates";

export interface Heading {
  level: number;
  text: string;
  /** 0-based line index in the Markdown source. */
  line: number;
  id: string | null;
}

export interface Labels {
  fig: string[];
  tbl: string[];
  eq: string[];
  sec: string[];
}

/** ATX headings outside fenced code blocks. */
export function headings(source: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  source.split("\n").forEach((raw, line) => {
    const fenceMatch = /^\s*(```|~~~)/.exec(raw);
    if (fenceMatch) {
      fence = fence === null ? fenceMatch[1] : fence === fenceMatch[1] ? null : fence;
      return;
    }
    if (fence) return;
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(raw);
    if (!m) return;
    const idMatch = /\{#([^}\s]+)[^}]*\}\s*$/.exec(m[2]);
    out.push({
      level: m[1].length,
      text: m[2].replace(/\s*\{[^}]*\}\s*$/, ""),
      line,
      id: idMatch ? idMatch[1] : null,
    });
  });
  return out;
}

export interface EffectiveHeading extends Heading {
  /** The level it is typeset at, 1 = `#`. */
  effectiveLevel: number;
}

/**
 * The level a heading after a part's first one is typeset at in a chapter template: a part is one
 * chapter, so a later heading at the first heading's level becomes one level deeper.
 */
export function levelInChapter(level: number, firstLevel: number): number {
  return level === firstLevel ? Math.min(level + 1, 6) : level;
}

/** `hs` (one part's headings) with the levels they are typeset at; identity outside chapter templates. */
export function withEffectiveLevels(hs: Heading[], chapters: boolean): EffectiveHeading[] {
  const first = hs[0]?.level;
  return hs.map((h, i) => ({ ...h, effectiveLevel: chapters && i > 0 ? levelInChapter(h.level, first) : h.level }));
}

/** One part's headings with the levels `template` typesets them at. */
export function effectiveHeadings(source: string, template: TemplateId | undefined): EffectiveHeading[] {
  return withEffectiveLevels(headings(source), usesChapters(template));
}

/** Labels that `@fig:` / `@tbl:` / `@eq:` / `@sec:` references can point to. */
export function labels(source: string): Labels {
  const out: Labels = { fig: [], tbl: [], eq: [], sec: [] };
  for (const m of source.matchAll(/\{#(fig|tbl|eq|sec):([^}\s]+)/g)) {
    const kind = m[1] as keyof Labels;
    const id = `${kind}:${m[2]}`;
    if (!out[kind].includes(id)) out[kind].push(id);
  }
  return out;
}

export { wordCount } from "./wordcount";
