import type { Tree } from "@lezer/common";

export interface SpellToken {
  from: number;
  to: number;
  word: string;
}

/** Markdown syntax nodes whose text is never prose. */
const SKIPPED_NODES = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "HTMLBlock",
  "HTMLTag",
  "Comment",
  "CommentBlock",
  "ProcessingInstruction",
  "ProcessingInstructionBlock",
  "URL",
  "Autolink",
  "LinkLabel",
]);

/** LaTeX commands whose braced argument is prose, so only the command name is skipped. */
const PROSE_COMMANDS = new Set([
  "textbf",
  "textit",
  "textsl",
  "textsc",
  "textrm",
  "textsf",
  "emph",
  "underline",
  "footnote",
  "caption",
  "chapter",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "title",
  "mbox",
]);

/** Pandoc syntax the Markdown parser does not know about. */
const SKIPPED_PATTERNS: RegExp[] = [
  // Display and inline math.
  /(?<!\\)\$\$[\s\S]+?\$\$|(?<![\\$])\$[^$\n]+?\$/g,
  // Citations and cross references: @key, [@key], -@key.
  /(?<![\w\\])@[\w:.#$%&+?<>~/-]*\w/g,
  // Attribute blocks: {#sec:intro}, {.class key=value}, {=latex}.
  /\{\s*(?:[#.=][^{}\n]*|[^{}\n]*=[^{}\n]*)\}/g,
  // Bare URLs and e-mail addresses.
  /\b(?:https?:\/\/|www\.)[^\s<>()[\]]+|[\w.+-]+@[\w-]+\.[\w.-]+/g,
];

const LATEX_COMMAND = /\\([a-zA-Z@]+)\*?/g;
const LATEX_ARGUMENT = /^\s*(?:\[[^\]\n]*\]|\{[^{}\n]*\})/;

const WORD = /[\p{L}\p{M}\p{N}_]+(?:['’][\p{L}\p{M}\p{N}_]+)*/gu;

type Zone = [from: number, to: number];

function latexZones(text: string, offset: number, zones: Zone[]) {
  LATEX_COMMAND.lastIndex = 0;
  for (let m = LATEX_COMMAND.exec(text); m; m = LATEX_COMMAND.exec(text)) {
    let end = m.index + m[0].length;
    if (!PROSE_COMMANDS.has(m[1])) {
      for (let arg = LATEX_ARGUMENT.exec(text.slice(end)); arg; arg = LATEX_ARGUMENT.exec(text.slice(end))) {
        end += arg[0].length;
      }
    }
    zones.push([offset + m.index, offset + end]);
    LATEX_COMMAND.lastIndex = end;
  }
}

/** Ranges of `text` (which starts at `offset` in the document) that are not prose. */
export function skipZones(text: string, offset: number, tree: Tree): Zone[] {
  const zones: Zone[] = [];
  tree.iterate({
    from: offset,
    to: offset + text.length,
    enter: (node) => {
      if (!SKIPPED_NODES.has(node.name)) return true;
      zones.push([node.from, node.to]);
      return false;
    },
  });
  for (const re of SKIPPED_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) zones.push([offset + m.index, offset + m.index + m[0].length]);
  }
  latexZones(text, offset, zones);
  return zones.sort((a, b) => a[0] - b[0]);
}

/** Words worth looking up: no digits or underscores, acronyms (ALL CAPS) or camelCase names. */
export function isCheckable(word: string): boolean {
  if (word.length < 2 || /[\p{N}_]/u.test(word)) return false;
  if (word === word.toUpperCase()) return false;
  return !/\p{Ll}\p{Lu}/u.test(word);
}

/**
 * The prose words of `text`, a slice of the document starting at `offset` that should begin and
 * end on line boundaries. Math, code, citations, attributes, URLs, raw LaTeX and HTML are skipped.
 */
export function spellTokens(text: string, offset: number, tree: Tree): SpellToken[] {
  const zones = skipZones(text, offset, tree);
  const tokens: SpellToken[] = [];
  let z = 0;
  let zoneEnd = -1;
  WORD.lastIndex = 0;
  for (let m = WORD.exec(text); m; m = WORD.exec(text)) {
    const from = offset + m.index;
    const to = from + m[0].length;
    while (z < zones.length && zones[z][0] < to) zoneEnd = Math.max(zoneEnd, zones[z++][1]);
    if (zoneEnd > from || !isCheckable(m[0])) continue;
    tokens.push({ from, to, word: m[0] });
  }
  return tokens;
}

export function normalizeWord(word: string): string {
  return word.trim().replace(/’/g, "'");
}

/** The project's and the user's words as one lookup set. */
export function mergeWords(...lists: Iterable<string>[]): Set<string> {
  const words = new Set<string>();
  for (const list of lists) {
    for (const w of list) {
      const word = normalizeWord(w);
      if (word) words.add(word);
    }
  }
  return words;
}

/**
 * Hunspell casing rules for personal words: a lowercase entry also accepts the capitalized and
 * ALL CAPS forms, and a capitalized entry accepts ALL CAPS, but not the other way round.
 */
export function isListed(word: string, words: ReadonlySet<string>): boolean {
  const w = normalizeWord(word);
  if (words.has(w)) return true;
  const lower = w.toLowerCase();
  const capitalized = lower.charAt(0).toUpperCase() + lower.slice(1);
  if (w === capitalized || w === w.toUpperCase()) {
    if (words.has(lower)) return true;
  }
  return w === w.toUpperCase() && words.has(capitalized);
}
