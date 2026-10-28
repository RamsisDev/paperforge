// Fuzzy line matching between three renderings of the same prose: the Markdown source, the
// generated paper.tex, and the PDF's text layer. Used to jump from an error or a click in the
// preview back to the Markdown line.

const STOP = new Set(["the", "and", "of", "a", "to", "in", "is", "for", "de", "la", "el", "y", "en"]);

/** Lowercase words with Markdown and LaTeX markup stripped. */
export function words(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\\(?:cite[pt]?|ref|eqref|label|href|url)\{[^}]*\}/g, " ")
    .replace(/\[@[^\]]*\]|@[\w:.-]+/g, " ")
    .replace(/\\[a-zA-Z]+\*?/g, " ")
    .replace(/\$[^$]*\$/g, " ")
    .replace(/[{}[\]()*_`#>|~^\\$%&=:;,.!?"'“”‘’]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/^\d+$/.test(w));
}

function shingles(ws: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < ws.length; i++) out.add(`${ws[i]} ${ws[i + 1]}`);
  for (const w of ws) if (!STOP.has(w) && w.length > 3) out.add(w);
  return out;
}

export interface LineMatch {
  /** 0-based line index. */
  line: number;
  score: number;
}

/**
 * Best line in `lines` for `needle`, comparing word bigrams and distinctive words. Each line
 * is scored together with the next one because the PDF and paper.tex break lines differently,
 * so neighbours often tie; `focus` (the word that was clicked) breaks the tie.
 */
export function bestLine(needle: string, lines: string[], focus?: string): LineMatch | null {
  const target = shingles(words(needle));
  if (target.size === 0) return null;
  const lineWords = lines.map(words);
  const scored: LineMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lineWords[i].length === 0) continue;
    const window = shingles([...lineWords[i], ...(lineWords[i + 1] ?? []).slice(0, 4)]);
    let hits = 0;
    for (const s of target) if (window.has(s)) hits++;
    if (hits > 0) scored.push({ line: i, score: hits / target.size });
  }
  if (scored.length === 0) return null;
  const top = Math.max(...scored.map((m) => m.score));
  if (top < 0.25) return null;
  const close = scored.filter((m) => m.score >= top * 0.75);
  const focusWord = focus ? words(focus)[0] : undefined;
  const focused = focusWord ? close.find((m) => lineWords[m.line].includes(focusWord)) : undefined;
  return focused ?? close.find((m) => m.score === top)!;
}
