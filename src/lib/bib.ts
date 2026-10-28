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
