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
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { lintGutter, lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  WidgetType,
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
import type { Part } from "@/lib/api";
import { labels, levelInChapter, type Labels } from "@/lib/outline";
import { allText } from "@/lib/parts";
import { usesChapters } from "@/lib/templates";
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

let labelCache: { parts: Part[]; labels: Labels } = { parts: [], labels: labels("") };

/** Labels from every part: a reference may point into another file. */
function documentLabels(): Labels {
  const parts = store.get().parts;
  if (parts !== labelCache.parts) labelCache = { parts, labels: labels(allText(parts)) };
  return labelCache.labels;
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
  for (const [kind, ids] of Object.entries(documentLabels())) {
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
  { label: "/toc", detail: "Table of contents here", template: SNIPPETS.toc },
  { label: "/lof", detail: "List of figures here", template: SNIPPETS.lof },
  { label: "/lot", detail: "List of tables here", template: SNIPPETS.lot },
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

/** Whether the project's template typesets each part as one chapter. */
export const setChapterTemplate = StateEffect.define<boolean>();

const chapterTemplate = StateField.define<boolean>({
  create: () => usesChapters(store.get().meta?.template),
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(setChapterTemplate) ? e.value : v), value),
});

/** Brings the view's chapter-template flag in line with the project; states may predate a template change. */
export function syncChapterTemplate(view: EditorView) {
  const current = view.state.field(chapterTemplate, false);
  const chapters = usesChapters(store.get().meta?.template);
  if (current !== undefined && current !== chapters) view.dispatch({ effects: setChapterTemplate.of(chapters) });
}

const LATEX_LEVELS = ["", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"];

class SectionOfWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  eq(other: SectionOfWidget) {
    return other.label === this.label;
  }
  toDOM() {
    const dom = document.createElement("span");
    dom.className = "pf-section-of";
    dom.textContent = this.label;
    return dom;
  }
}

function atxLevel(name: string): number {
  return name.startsWith("ATXHeading") ? Number(name.slice(10)) : 0;
}

/**
 * In a chapter template, marks the later headings at the first heading's level, which are typeset
 * one level deeper. Only top-level syntax nodes in the visible ranges are visited.
 */
function chapterSections(view: EditorView): DecorationSet {
  const { state } = view;
  if (!state.field(chapterTemplate) || view.visibleRanges.length === 0) return Decoration.none;
  const tree = syntaxTree(state);
  const end = view.visibleRanges[view.visibleRanges.length - 1].to;
  const cursor = tree.cursor();
  let first: { level: number; from: number; to: number } | null = null;
  if (cursor.firstChild()) {
    do {
      const level = atxLevel(cursor.name);
      if (level) first = { level, from: cursor.from, to: cursor.to };
    } while (!first && cursor.from < end && cursor.nextSibling());
  }
  if (!first) return Decoration.none;
  const chapter = first;
  const title = state
    .sliceDoc(chapter.from, chapter.to)
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/\s*\{[^}]*\}\s*$/, "")
    .replace(/\s+#+\s*$/, "");
  const widget = new SectionOfWidget(`${LATEX_LEVELS[levelInChapter(chapter.level, chapter.level)]} of “${title}”`);
  const marks: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.type.isTop) return true;
        if (node.from > chapter.from && atxLevel(node.name) === chapter.level) {
          marks.push(Decoration.widget({ widget, side: 1 }).range(state.doc.lineAt(node.from).to));
        }
        return false;
      },
    });
  }
  return Decoration.set(marks, true);
}

const chapterSectionBadges = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = chapterSections(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        syntaxTree(u.state) !== syntaxTree(u.startState) ||
        u.state.field(chapterTemplate) !== u.startState.field(chapterTemplate)
      ) {
        this.decorations = chapterSections(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

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
    chapterTemplate,
    chapterSectionBadges,
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
