import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  hoverTooltip,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import katex from "katex";
import { parseBib, shortAuthors } from "@/lib/bib";
import { labels } from "@/lib/outline";
import { store } from "@/store";
import { SNIPPETS, formatting } from "./commands";

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700", fontSize: "1.25em", color: "var(--pf-syn-heading)" },
  { tag: t.heading2, fontWeight: "700", fontSize: "1.12em", color: "var(--pf-syn-heading)" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "700", color: "var(--pf-syn-heading)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic", color: "var(--pf-syn-emph)" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--pf-syn-link)" },
  { tag: t.monospace, color: "var(--pf-syn-code)" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator, t.labelName], color: "var(--pf-syn-meta)" },
  { tag: t.quote, color: "var(--pf-muted)", fontStyle: "italic" },
  { tag: t.list, color: "var(--pf-accent)" },
  { tag: [t.keyword, t.operator], color: "var(--pf-syn-emph)" },
  { tag: [t.string, t.special(t.string)], color: "var(--pf-syn-math)" },
  { tag: [t.comment], color: "var(--pf-syn-meta)", fontStyle: "italic" },
  { tag: [t.number, t.bool], color: "var(--pf-syn-cite)" },
]);

function markRegex(regexp: RegExp, className: string): Extension {
  const decorator = new MatchDecorator({ regexp, decoration: Decoration.mark({ class: className }) });
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
      }
      update(u: ViewUpdate) {
        this.decorations = decorator.updateDeco(u, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** The `$…$` or `$$…$$` span around `pos`, if any. */
function mathAt(state: EditorState, pos: number): { from: number; to: number; tex: string; display: boolean } | null {
  const windowFrom = Math.max(0, pos - 2000);
  const text = state.sliceDoc(windowFrom, Math.min(state.doc.length, pos + 2000));
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const from = windowFrom + m.index;
    const to = from + m[0].length;
    if (from > pos) break;
    if (pos <= to) return { from, to, tex: (m[1] ?? m[2]).trim(), display: m[1] !== undefined };
  }
  return null;
}

const mathTooltip = hoverTooltip(
  (view, pos) => {
    const math = mathAt(view.state, pos);
    if (!math) return null;
    return {
      pos: math.from,
      end: math.to,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "pf-math-tooltip";
        katex.render(math.tex, dom, { displayMode: math.display, throwOnError: false, output: "html" });
        return { dom };
      },
    };
  },
  { hoverTime: 250 },
);

const REF_KINDS: Record<string, string> = { fig: "Figure", tbl: "Table", eq: "Equation", sec: "Section" };

let bibCache: { source: string; entries: ReturnType<typeof parseBib> } = { source: "", entries: [] };

function bibEntries() {
  const source = store.get().bib;
  if (source !== bibCache.source) bibCache = { source, entries: parseBib(source) };
  return bibCache.entries;
}

function citationCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/@[\w:.-]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const charBefore = context.state.sliceDoc(word.from - 1, word.from);
  if (/\w/.test(charBefore)) return null;
  const options: Completion[] = bibEntries().map((e) => ({
    label: `@${e.key}`,
    detail: [shortAuthors(e.author), e.year].filter(Boolean).join(", "),
    info: e.title || undefined,
    type: "text",
    boost: 1,
  }));
  const found = labels(context.state.doc.toString());
  for (const [kind, ids] of Object.entries(found)) {
    for (const id of ids) options.push({ label: `@${id}`, detail: REF_KINDS[kind], type: "variable" });
  }
  return { from: word.from, options, validFor: /^@[\w:.-]*$/ };
}

const SLASH_COMMANDS: { label: string; detail: string; template: string }[] = [
  { label: "/figure", detail: "Image with caption and label", template: SNIPPETS.figure },
  { label: "/figure-wide", detail: "Figure across both columns", template: SNIPPETS.wideFigure },
  { label: "/table", detail: "Table with caption and label", template: SNIPPETS.table },
  { label: "/equation", detail: "Numbered display equation", template: SNIPPETS.equation },
  { label: "/code", detail: "Fenced code block", template: SNIPPETS.code },
  { label: "/quote", detail: "Block quote", template: SNIPPETS.quote },
  { label: "/section", detail: "Section with a label", template: SNIPPETS.section },
  { label: "/pagebreak", detail: "Start a new page", template: SNIPPETS.pageBreak },
];

function slashCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/^\s*\/[\w-]*/);
  if (!word) return null;
  const from = word.from + word.text.indexOf("/");
  return {
    from,
    options: SLASH_COMMANDS.map((c) => snippetCompletion(c.template, { label: c.label, detail: c.detail, type: "keyword" })),
    validFor: /^\/[\w-]*$/,
  };
}

const LATEX_COMMANDS: [string, string][] = [
  ["\\newpage", "Start a new page"],
  ["\\clearpage", "Flush floats and start a new page"],
  ["\\noindent", "No paragraph indent"],
  ["\\vspace{${1em}}", "Vertical space"],
  ["\\textbf{${text}}", "Bold"],
  ["\\emph{${text}}", "Emphasis"],
  ["\\textsc{${text}}", "Small caps"],
  ["\\footnote{${text}}", "Footnote"],
  ["\\url{${https://}}", "URL"],
  ["\\ref{${label}}", "Reference number"],
  ["\\eqref{${eq:label}}", "Equation reference"],
  ["\\cite{${key}}", "Citation"],
  ["\\LaTeX{}", "LaTeX logo"],
  ["\\appendix", "Start the appendix"],
];

function latexCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\\[a-zA-Z]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  if (mathAt(context.state, context.pos)) return null;
  return {
    from: word.from,
    options: LATEX_COMMANDS.map(([template, detail]) =>
      snippetCompletion(template, { label: template.replace(/\$\{[^}]*\}/g, "…"), detail, type: "function" }),
    ),
    validFor: /^\\[a-zA-Z]*$/,
  };
}

/** Briefly highlights a jumped-to line. */
export const flashLine = StateEffect.define<number | null>();

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashLine)) {
        deco = e.value === null ? Decoration.none : Decoration.set([Decoration.line({ class: "pf-flash" }).range(e.value)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const formattingKeymap = keymap.of([
  { key: "Mod-b", run: formatting.bold },
  { key: "Mod-i", run: formatting.italic },
  { key: "Mod-k", run: formatting.link },
  { key: "Mod-e", run: formatting.code },
  { key: "Mod-m", run: formatting.math },
  { key: "Mod-Shift-m", run: formatting.equation },
  { key: "Mod-Shift-c", run: formatting.citation },
  { key: "Mod-Shift-x", run: formatting.strike },
  { key: "Mod-Alt-1", run: formatting.h1 },
  { key: "Mod-Alt-2", run: formatting.h2 },
  { key: "Mod-Alt-3", run: formatting.h3 },
]);

function base(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    flashField,
    lintGutter(),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
  ];
}

export function markdownExtensions(onChange: Extension): Extension[] {
  return [
    formattingKeymap,
    ...base(),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(highlight),
    markRegex(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, "pf-math"),
    markRegex(/\[@[^\]\n]+\]|(?<![\w\\])@[\w:.-]*\w/g, "pf-cite"),
    markRegex(/\{[#.][^}\n]*\}/g, "pf-attr"),
    mathTooltip,
    autocompletion({ override: [slashCompletions, citationCompletions, latexCompletions], icons: false }),
    placeholder("Start writing… Type / for figures, tables and equations, @ to cite."),
    onChange,
  ];
}

export function bibExtensions(onChange: Extension): Extension[] {
  return [...base(), markRegex(/^@\w+\{[^,\n]*/gm, "pf-cite"), markRegex(/^\s*\w+\s*=/gm, "pf-attr"), onChange];
}

export function texExtensions(): Extension[] {
  return [...base(), EditorState.readOnly.of(true), markRegex(/\\[a-zA-Z@]+/g, "pf-attr"), markRegex(/\$[^$\n]+\$/g, "pf-math")];
}
