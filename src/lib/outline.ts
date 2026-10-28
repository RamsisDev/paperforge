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

export function wordCount(source: string): number {
  const prose = source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\{[#.][^}]*\}/g, " ")
    .replace(/[#*_>`|-]/g, " ");
  const matches = prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return matches ? matches.length : 0;
}
