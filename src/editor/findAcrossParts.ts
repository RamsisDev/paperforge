// Find and replace over every part of the document, without the DOM or an editor.

export interface FindOptions {
  query: string;
  regex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  /** Ignores matches that touch math, code, citations, attributes or raw LaTeX. */
  skipMarkup: boolean;
}

export interface TextMatch {
  from: number;
  to: number;
  /** 0-based line of `from`. */
  line: number;
  lineFrom: number;
  /** Text of the line `from` is on. */
  lineText: string;
  /** Capture groups 1..n of a regular expression match. */
  groups: (string | undefined)[];
  named?: Record<string, string | undefined>;
}

export interface PartMatches {
  file: string;
  matches: TextMatch[];
}

export interface FindResult {
  parts: PartMatches[];
  total: number;
  /** The search stopped at the match limit. */
  truncated: boolean;
  /** Why the query is not a valid regular expression. */
  error: string | null;
}

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

type Zone = [from: number, to: number];

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The search as a global regular expression; null for an empty query. Throws on invalid syntax. */
export function queryRegExp(opts: FindOptions): RegExp | null {
  if (!opts.query) return null;
  const source = opts.regex ? opts.query : escapeRegExp(opts.query);
  return new RegExp(source, opts.matchCase ? "gm" : "gim");
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/gm;

/** Fenced code blocks, ```` ```{=latex} ```` raw blocks included; an unclosed fence runs to the end. */
function fencedBlocks(text: string): Zone[] {
  const zones: Zone[] = [];
  let open: { marker: string; from: number } | null = null;
  FENCE.lastIndex = 0;
  for (let m = FENCE.exec(text); m; m = FENCE.exec(text)) {
    const marker = m[1];
    if (!open) open = { marker, from: m.index };
    else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && m[2].trim() === "") {
      zones.push([open.from, m.index + m[0].length]);
      open = null;
    }
  }
  if (open) zones.push([open.from, text.length]);
  return zones;
}

const INLINE_MARKUP = new RegExp(
  [
    String.raw`(?<!\\)\$\$[\s\S]+?\$\$`,
    String.raw`\\begin\{([^}\n]+)\}[\s\S]*?\\end\{\1\}`,
    String.raw`(?<!\x60)(\x60+)(?!\x60)(?:[^\n]|\n(?![ \t]*\n))+?(?<!\x60)\2(?!\x60)`,
    String.raw`(?<!\\)\$[^$\n]+?\$`,
    String.raw`\[[^[\]\n]*?(?<![\w\\])-?@[\w:.-]*\w[^[\]\n]*\]`,
    String.raw`(?<![\w\\])@[\w:.-]*\w`,
    String.raw`\{[#.=][^}\n]*\}`,
    String.raw`\\[a-zA-Z@]+\*?(?:\[[^\]\n]*\]|\{(?:[^{}\n]|\{[^{}\n]*\})*\})*`,
  ].join("|"),
  "g",
);

/** Ranges of math, code, citations, attributes and raw LaTeX, sorted and disjoint. */
export function markupZones(text: string): Zone[] {
  const fences = fencedBlocks(text);
  const zones: Zone[] = [];
  let from = 0;
  for (const fence of [...fences, [text.length, text.length] as Zone]) {
    const segment = text.slice(from, fence[0]);
    INLINE_MARKUP.lastIndex = 0;
    for (let m = INLINE_MARKUP.exec(segment); m; m = INLINE_MARKUP.exec(segment)) {
      zones.push([from + m.index, from + m.index + m[0].length]);
    }
    if (fence[1] > fence[0]) zones.push(fence);
    from = fence[1];
  }
  return zones;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWord(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function lineIndex(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function search(text: string, re: RegExp, opts: FindOptions, zones: Zone[] | null, limit: number): TextMatch[] {
  const matches: TextMatch[] = [];
  let starts: number[] | null = null;
  let zone = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m && matches.length < limit; m = re.exec(text)) {
    const from = m.index;
    const to = from + m[0].length;
    if (to === from) {
      re.lastIndex = from + 1;
      continue;
    }
    if (opts.wholeWord && ((isWord(m[0][0]) && isWord(text[from - 1])) || (isWord(m[0][m[0].length - 1]) && isWord(text[to])))) {
      re.lastIndex = from + 1;
      continue;
    }
    if (zones) {
      while (zone < zones.length && zones[zone][1] <= from) zone++;
      const hit = zones[zone];
      if (hit && hit[0] < to) {
        re.lastIndex = hit[0] <= from ? hit[1] : from + 1;
        continue;
      }
    }
    starts ??= lineStarts(text);
    const line = lineIndex(starts, from);
    const lineFrom = starts[line];
    const lineEnd = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
    matches.push({
      from,
      to,
      line,
      lineFrom,
      lineText: text.slice(lineFrom, lineEnd),
      groups: opts.regex ? m.slice(1) : [],
      named: opts.regex && m.groups ? { ...m.groups } : undefined,
    });
  }
  return matches;
}

/** Matches in one text, in order. Throws when the query is not a valid regular expression. */
export function findInText(text: string, opts: FindOptions, limit = Infinity): TextMatch[] {
  const re = queryRegExp(opts);
  return re ? search(text, re, opts, opts.skipMarkup ? markupZones(text) : null, limit) : [];
}

export const MAX_MATCHES = 2000;

const zoneCache = new WeakMap<object, { text: string; zones: Zone[] }>();

function cachedZones(part: { content: string }): Zone[] {
  let hit = zoneCache.get(part);
  if (!hit || hit.text !== part.content) {
    hit = { text: part.content, zones: markupZones(part.content) };
    zoneCache.set(part, hit);
  }
  return hit.zones;
}

/** Matches in every part, in reading order, up to `limit` in total. */
export function findAcrossParts(parts: { file: string; content: string }[], opts: FindOptions, limit = MAX_MATCHES): FindResult {
  let re: RegExp | null;
  try {
    re = queryRegExp(opts);
  } catch (e) {
    return { parts: [], total: 0, truncated: false, error: e instanceof Error ? e.message : String(e) };
  }
  const result: FindResult = { parts: [], total: 0, truncated: false, error: null };
  if (!re) return result;
  for (const part of parts) {
    const left = limit - result.total;
    if (left <= 0) {
      result.truncated = true;
      break;
    }
    const matches = search(part.content, re, opts, opts.skipMarkup ? cachedZones(part) : null, left);
    if (matches.length === 0) continue;
    result.parts.push({ file: part.file, matches });
    result.total += matches.length;
  }
  return result;
}

/**
 * The text that replaces one match. Regular expressions expand `$1`…`$99`, `$<name>`, `$&` and
 * `$$` as `String.prototype.replace` does; a plain search inserts `replace` as it is.
 */
export function expandReplacement(replace: string, match: TextMatch, matched: string, regex: boolean): string {
  if (!regex) return replace;
  return replace.replace(/\$(\$|&|<([^>]*)>|(\d)(\d)?)/g, (all, token: string, name?: string, d1?: string, d2?: string) => {
    if (token === "$") return "$";
    if (token === "&") return matched;
    if (name !== undefined) return match.named ? (match.named[name] ?? "") : all;
    const count = match.groups.length;
    if (d2 !== undefined) {
      const two = Number(d1 + d2);
      if (two >= 1 && two <= count) return match.groups[two - 1] ?? "";
    }
    const one = Number(d1);
    if (one >= 1 && one <= count) return (match.groups[one - 1] ?? "") + (d2 ?? "");
    return all;
  });
}

/** One change per match, against the text the matches were found in. */
export function replacementChanges(text: string, matches: TextMatch[], replace: string, regex: boolean): TextChange[] {
  return matches.map((m) => ({ from: m.from, to: m.to, insert: expandReplacement(replace, m, text.slice(m.from, m.to), regex) }));
}

export function applyChanges(text: string, changes: TextChange[]): string {
  let out = "";
  let at = 0;
  for (const c of changes) {
    out += text.slice(at, c.from) + c.insert;
    at = c.to;
  }
  return out + text.slice(at);
}

export function replaceInText(text: string, opts: FindOptions, replace: string): string {
  return applyChanges(text, replacementChanges(text, findInText(text, opts), replace, opts.regex));
}
