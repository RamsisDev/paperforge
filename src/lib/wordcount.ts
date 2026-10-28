const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** LaTeX commands whose braced argument is prose, so only the command itself is dropped. */
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
  "mbox",
]);

const MARKUP = new RegExp(
  [
    String.raw`<!--[\s\S]*?-->`,
    String.raw`(?<!\\)\$\$[\s\S]+?\$\$`,
    String.raw`\\begin\{([^}\n]+)\}[\s\S]*?\\end\{\1\}`,
    String.raw`(\x60+)(?:[^\n]|\n(?![ \t]*\n))+?\2`,
    String.raw`(?<![\\$])\$(?=\S)[^$\n]+?(?<=\S)\$(?!\d)`,
    String.raw`\[[^[\]\n]*?(?<![\w\\])-?@[\w:.-]*\w[^[\]\n]*\]`,
    String.raw`(?<![\w\\])-?@[\w:.-]*\w`,
    String.raw`\{\s*(?:[#.=][^{}\n]*|[^{}\n]*=[^{}\n]*)\}`,
    String.raw`\]\([^)\n]*\)`,
    String.raw`\[\^[^\]\n]*\]`,
    String.raw`\b(?:https?://|www\.)[^\s<>()[\]]+`,
    String.raw`<[a-zA-Z/][^>\n]*>`,
    String.raw`\\([a-zA-Z@]+)\*?((?:\[[^\]\n]*\]|\{(?:[^{}\n]|\{[^{}\n]*\})*\})*)`,
  ].join("|"),
  "g",
);

const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu;

/** The text with fenced code (raw ```` ```{=latex} ```` included) and `:::` div fences removed. */
function withoutFences(source: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of source.split("\n")) {
    const m = FENCE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && m[2].trim() === "") fence = null;
    } else if (m) fence = m[1];
    else if (!/^ {0,3}:{3,}/.test(line)) kept.push(line);
  }
  return kept.join("\n");
}

/** Keeps the prose arguments of formatting commands such as `\emph{…}`; drops every other command. */
function dropMarkup(_match: string, _env?: string, _ticks?: string, command?: string, args?: string): string {
  if (command === undefined || !PROSE_COMMANDS.has(command) || !args) return " ";
  return ` ${args.replace(/\[[^\]\n]*\]/g, " ").replace(/[{}]/g, " ")} `;
}

/**
 * Words of prose in a Markdown part, as a reader would count them: math, code, citations and
 * cross references, attribute blocks, link targets, raw LaTeX, HTML and comments are skipped.
 */
export function wordCount(source: string): number {
  const prose = withoutFences(source).replace(MARKUP, dropMarkup);
  return prose.match(WORD)?.length ?? 0;
}
