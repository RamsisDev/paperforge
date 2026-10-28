import { snippet } from "@codemirror/autocomplete";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** Wraps each selection in `before`/`after`, or unwraps it when it already is. */
export function wrap(view: EditorView, before: string, after = before, placeholder = "text"): boolean {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const outerFrom = range.from - before.length;
    const outerTo = range.to + after.length;
    const isWrapped =
      outerFrom >= 0 &&
      state.sliceDoc(outerFrom, range.from) === before &&
      state.sliceDoc(range.to, outerTo) === after;
    if (isWrapped) {
      return {
        changes: [
          { from: outerFrom, to: range.from, insert: "" },
          { from: range.to, to: outerTo, insert: "" },
        ],
        range: EditorSelection.range(outerFrom, range.to - before.length),
      };
    }
    const inner = range.empty ? placeholder : state.sliceDoc(range.from, range.to);
    return {
      changes: { from: range.from, to: range.to, insert: before + inner + after },
      range: EditorSelection.range(range.from + before.length, range.from + before.length + inner.length),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
  view.focus();
  return true;
}

/** Sets (or clears, when already set) a line prefix such as `## `, `- ` or `> ` on selected lines. */
export function linePrefix(view: EditorView, prefix: string): boolean {
  const { state } = view;
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) lines.add(n);
  }
  const isHeading = /^#+ $/.test(prefix);
  const changes = [...lines].map((n) => {
    const line = state.doc.line(n);
    const existing = isHeading ? /^#{1,6} /.exec(line.text) : null;
    if (line.text.startsWith(prefix)) return { from: line.from, to: line.from + prefix.length, insert: "" };
    if (existing) return { from: line.from, to: line.from + existing[0].length, insert: prefix };
    return { from: line.from, insert: prefix };
  });
  view.dispatch({ changes, userEvent: "input", scrollIntoView: true });
  view.focus();
  return true;
}

/**
 * Inserts a snippet (`${name}` fields, Tab to move between them) as its own paragraph:
 * blank lines are added so Markdown block syntax is recognized.
 */
export function insertBlock(view: EditorView, template: string): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const atLineStart = pos === line.from && line.text.trim() === "";
  const from = atLineStart ? line.from : line.to;
  const before = state.doc.sliceString(Math.max(0, from - 2), from);
  const lead = from === 0 ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") || atLineStart ? "\n" : "\n\n";
  const next = state.doc.sliceString(from, from + 2);
  const trail = next.startsWith("\n\n") || from === state.doc.length ? "\n" : "\n\n";
  snippet(lead + template + trail)(view, null, from, from);
  view.focus();
  return true;
}

/** Inserts a snippet at the cursor, replacing the selection. */
export function insertInline(view: EditorView, template: string): boolean {
  const { from, to } = view.state.selection.main;
  snippet(template)(view, null, from, to);
  view.focus();
  return true;
}

export const SNIPPETS = {
  figure: "![${Caption}](${figures/image.png}){#fig:${label} width=80%}",
  wideFigure: "![${Caption}](${figures/image.png}){#fig:${label} .wide width=100%}",
  table:
    "| ${Column A} | Column B |\n|:-----------|---------:|\n| Cell       |     Cell |\n\n: ${Caption} {#tbl:${label}}",
  equation: "$$\n${E = mc^2}\n$$ {#eq:${label}}",
  code: "```${python}\n${code}\n```",
  quote: "> ${Quote}",
  section: "# ${Section} {#sec:${label}}",
  pageBreak: "\\newpage",
  toc: "\\tableofcontents",
  lof: "\\listoffigures",
  lot: "\\listoftables",
};

export const formatting = {
  bold: (v: EditorView) => wrap(v, "**", "**", "bold"),
  italic: (v: EditorView) => wrap(v, "*", "*", "italic"),
  strike: (v: EditorView) => wrap(v, "~~", "~~", "text"),
  code: (v: EditorView) => wrap(v, "`", "`", "code"),
  math: (v: EditorView) => wrap(v, "$", "$", "x^2"),
  superscript: (v: EditorView) => wrap(v, "^", "^", "2"),
  link: (v: EditorView) => insertInline(v, `[${v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to) || "${text}"}](\${https://})`),
  citation: (v: EditorView) => insertInline(v, "[@${key}]"),
  footnote: (v: EditorView) => insertInline(v, "^[${Footnote text}]"),
  h1: (v: EditorView) => linePrefix(v, "# "),
  h2: (v: EditorView) => linePrefix(v, "## "),
  h3: (v: EditorView) => linePrefix(v, "### "),
  bullet: (v: EditorView) => linePrefix(v, "- "),
  numbered: (v: EditorView) => linePrefix(v, "1. "),
  quote: (v: EditorView) => linePrefix(v, "> "),
  figure: (v: EditorView) => insertBlock(v, SNIPPETS.figure),
  table: (v: EditorView) => insertBlock(v, SNIPPETS.table),
  equation: (v: EditorView) => insertBlock(v, SNIPPETS.equation),
  codeBlock: (v: EditorView) => insertBlock(v, SNIPPETS.code),
  toc: (v: EditorView) => insertBlock(v, SNIPPETS.toc),
  lof: (v: EditorView) => insertBlock(v, SNIPPETS.lof),
  lot: (v: EditorView) => insertBlock(v, SNIPPETS.lot),
};
