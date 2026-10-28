export interface BibEntry {
  key: string;
  type: string;
  title: string;
  author: string;
  year: string;
  /** 1-based line of the `@type{key,` header in refs.bib. */
  line: number;
}

const FIELD_NAMES = ["title", "author", "year"] as const;

/** Value of a `name = {…}` / `name = "…"` / `name = 1999` field, braces balanced. */
function fieldValue(body: string, name: string): string {
  const match = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*`, "i").exec(body);
  if (!match) return "";
  let i = match.index + match[0].length;
  const open = body[i];
  if (open === "{" || open === '"') {
    const close = open === "{" ? "}" : '"';
    let depth = 0;
    const start = i + 1;
    for (i = start; i < body.length; i++) {
      const c = body[i];
      if (c === "{" && open === "{") depth++;
      else if (c === "}" && depth > 0) depth--;
      else if (c === close && depth === 0) return clean(body.slice(start, i));
    }
    return clean(body.slice(start));
  }
  const bare = /^[^,}\s]+/.exec(body.slice(i));
  return bare ? clean(bare[0]) : "";
}

function clean(value: string): string {
  return value
    .replace(/\\(La)?TeX\b\s*/g, (_, la: string | undefined) => (la ? "LaTeX" : "TeX"))
    .replace(/\\[a-zA-Z]+\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseBib(source: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const header = /@([a-zA-Z]+)\s*[{(]\s*([^,\s]+)\s*,/g;
  const starts: { type: string; key: string; index: number; end: number }[] = [];
  for (let m = header.exec(source); m; m = header.exec(source)) {
    const type = m[1].toLowerCase();
    if (type === "comment" || type === "string" || type === "preamble") continue;
    starts.push({ type, key: m[2], index: m.index, end: header.lastIndex });
  }
  for (let n = 0; n < starts.length; n++) {
    const s = starts[n];
    const body = source.slice(s.end, n + 1 < starts.length ? starts[n + 1].index : source.length);
    const fields = Object.fromEntries(FIELD_NAMES.map((f) => [f, fieldValue(body, f)]));
    entries.push({
      key: s.key,
      type: s.type,
      title: fields.title,
      author: fields.author,
      year: fields.year,
      line: source.slice(0, s.index).split("\n").length,
    });
  }
  return entries;
}

/** `text` after the existing bytes of `bib`, a blank line between; `line` is where it starts, 0-based. */
export function appendToBib(bib: string, text: string): { bib: string; line: number } {
  const sep = bib.trim() === "" ? "" : bib.endsWith("\n\n") ? "" : bib.endsWith("\n") ? "\n" : "\n\n";
  const head = bib + sep;
  return { bib: head + text, line: head.split("\n").length - 1 };
}

export interface EntryRange {
  key: string;
  /** Offsets of the entry in the source, from its `@` to just past its closing delimiter. */
  from: number;
  to: number;
}

/** Where each entry is; an unclosed entry runs to the next one. */
export function entryRanges(source: string): EntryRange[] {
  const header = /@([a-zA-Z]+)\s*([{(])\s*([^,\s]+)\s*,/g;
  const found: { key: string; from: number; open: number; delim: string }[] = [];
  for (let m = header.exec(source); m; m = header.exec(source)) {
    if (/^(comment|string|preamble)$/i.test(m[1])) continue;
    found.push({ key: m[3], from: m.index, open: m.index + m[0].indexOf(m[2]), delim: m[2] });
  }
  return found.map((e, n) => {
    const limit = n + 1 < found.length ? found[n + 1].from : source.length;
    let depth = 0;
    for (let i = e.open; i < limit; i++) {
      const c = source[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      if ((e.delim === "{" && depth === 0 && c === "}") || (e.delim === "(" && depth === 0 && c === ")")) {
        return { key: e.key, from: e.from, to: i + 1 };
      }
    }
    return { key: e.key, from: e.from, to: e.from + source.slice(e.from, limit).trimEnd().length };
  });
}

const layoutFree = (entry: string) => entry.replace(/\s+/g, " ").replace(/\s*([,{}()=])\s*/g, "$1").trim();

/**
 * Brings the entries of `incoming` into `bib`: an entry whose key is new is appended, one whose
 * text differs replaces that entry in place, and every other byte of `bib` stays as it was.
 */
export function mergeBib(bib: string, incoming: string): { bib: string; added: string[]; updated: string[] } {
  const current = new Map<string, EntryRange>();
  for (const r of entryRanges(bib)) if (!current.has(r.key)) current.set(r.key, r);
  const seen = new Set<string>();
  const replacements: { range: EntryRange; text: string }[] = [];
  const fresh: { key: string; text: string }[] = [];
  for (const r of entryRanges(incoming)) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    const text = incoming.slice(r.from, r.to);
    const existing = current.get(r.key);
    if (!existing) fresh.push({ key: r.key, text });
    else if (layoutFree(bib.slice(existing.from, existing.to)) !== layoutFree(text)) {
      replacements.push({ range: existing, text });
    }
  }
  let next = bib;
  for (const { range, text } of [...replacements].sort((a, b) => b.range.from - a.range.from)) {
    next = next.slice(0, range.from) + text + next.slice(range.to);
  }
  if (fresh.length > 0) next = appendToBib(next, `${fresh.map((f) => f.text).join("\n\n")}\n`).bib;
  return { bib: next, added: fresh.map((f) => f.key), updated: replacements.map((r) => r.range.key) };
}

/** "Donald E. Knuth and Leslie Lamport" -> "Knuth & Lamport"; three or more -> "Knuth et al." */
export function shortAuthors(author: string): string {
  const names = author.split(/\s+and\s+/i).map((n) => {
    const trimmed = n.trim();
    if (trimmed.includes(",")) return trimmed.split(",")[0].trim();
    return trimmed.split(/\s+/).pop() ?? trimmed;
  });
  if (names.length === 0 || !names[0]) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} et al.`;
}
