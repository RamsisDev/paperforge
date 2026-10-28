import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, type WidgetType } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { figureAttribute, figureId, parseFigure } from "@/editor/figureSyntax";
import { refDetail, refKind, refName } from "@/lib/refnames";
import { labelRef, store } from "@/store";
import { blockDecorations, inlineWidget, previewReplace } from "./registry";
import {
  citationText,
  divFence,
  plainCaption,
  rawFormat,
  referenceText,
  scanInline,
  type InlineToken,
  type Span,
} from "./syntax";
import { ChipWidget, FenceLabelWidget, FigureWidget, MathWidget, bibEntry } from "./widgets";

const lineClass = (className: string) => Decoration.line({ class: className });
const HEADING_LINES = [1, 2, 3, 4, 5, 6].map((n) => lineClass(`pf-lp-heading pf-lp-h${n}`));
const QUOTE_LINE = lineClass("pf-lp-quote");
const CODE_LINE = lineClass("pf-lp-code");
const RAW_LINE = lineClass("pf-lp-raw");
const DIV_LINE = lineClass("pf-lp-div");
const RAW_INLINE = Decoration.mark({ class: "pf-lp-raw-inline" });

/** The top-level blocks that touch `from`..`to`, ends included. */
export function topBlocks(tree: Tree, from: number, to: number): SyntaxNode[] {
  const blocks: SyntaxNode[] = [];
  const top = tree.topNode;
  let node: SyntaxNode | null = top.childBefore(from) ?? top.firstChild;
  if (node && node.to < from) node = node.nextSibling;
  for (; node && node.from <= to; node = node.nextSibling) blocks.push(node);
  return blocks;
}

function language() {
  return store.get().meta?.language;
}

function defaultInlineWidget(token: InlineToken, state: EditorState): WidgetType | null {
  switch (token.kind) {
    case "math": {
      const ref = token.label ? labelRef(token.label) : undefined;
      return new MathWidget(token.tex, token.display, ref?.number ? `(${ref.number})` : token.label);
    }
    case "cite": {
      const texts = token.items.map((item) => {
        if (refKind(item.key)) return referenceText(item.key, labelRef(item.key), language(), "");
        return citationText(item, bibEntry(item.key));
      });
      const missing = token.items.some((item) => !refKind(item.key) && !bibEntry(item.key));
      const title = token.items.map((item) => `@${item.key}${item.locator ? `, ${item.locator}` : ""}`).join("; ");
      return new ChipWidget(texts.join("; "), missing ? "cite pf-lp-missing" : "cite", title);
    }
    case "ref": {
      const line = state.doc.lineAt(token.from);
      const before = state.sliceDoc(line.from, token.from);
      const ref = labelRef(token.id);
      const missing = ref === undefined && Object.keys(store.get().labels).length > 0;
      return new ChipWidget(
        referenceText(token.id, ref, language(), before),
        missing ? "ref pf-lp-missing" : "ref",
        `@${token.id} · ${refDetail(token.id, ref)}`,
      );
    }
    case "footnote":
      return new ChipWidget("note", "footnote", token.text, 2);
    case "footnoteRef":
      return new ChipWidget(token.id, "footnote", `[^${token.id}]`, 2);
    case "attr": {
      const { id, classes } = token.attrs;
      const text = [id, ...classes.map((c) => `.${c}`)].filter(Boolean).join(" ");
      return text ? new ChipWidget(text, "attr", "", 1) : null;
    }
    case "rawInline":
      return null;
  }
}

function tokenDecorations(token: InlineToken, state: EditorState, out: Range<Decoration>[]) {
  const widget = inlineWidget(token, state) ?? defaultInlineWidget(token, state);
  if (widget) {
    out.push(previewReplace(token.from, token.to, widget));
  } else if (token.kind === "rawInline") {
    if (token.code.from < token.code.to) out.push(RAW_INLINE.range(token.code.from, token.code.to));
    out.push(previewReplace(token.open.from, token.open.to), previewReplace(token.close.from, token.close.to));
  } else if (token.kind === "attr") {
    out.push(previewReplace(token.from, token.to));
  }
}

function overlaps(from: number, to: number, taken: readonly Span[]): boolean {
  return taken.some((s) => s.from < to && s.to > from);
}

/** Hides emphasis, code and link marks inside `node`, except where a Pandoc token took over. */
function markDecorations(node: SyntaxNode, state: EditorState, taken: readonly Span[], out: Range<Decoration>[]) {
  const cursor = node.cursor();
  if (!cursor.firstChild()) return;
  const end = node.to;
  do {
    const { name, from, to } = cursor;
    if (from >= end) break;
    if (overlaps(from, to, taken)) continue;
    if (name === "EmphasisMark" || name === "StrikethroughMark" || name === "CodeMark") {
      out.push(previewReplace(from, to));
    } else if (name === "Link") {
      const link = cursor.node;
      const marks = link.getChildren("LinkMark");
      if (link.getChild("URL") && marks.length >= 2 && state.sliceDoc(marks[0].from, marks[0].to) === "[") {
        out.push(previewReplace(marks[0].from, marks[0].to), previewReplace(marks[1].from, link.to));
      }
      continue;
    } else if (name === "Image") {
      continue;
    }
    markDecorations(cursor.node, state, taken, out);
  } while (cursor.nextSibling());
}

/** Pandoc tokens and Markdown marks in `from`..`to` of a paragraph-like `node`. */
function inlineDecorations(node: SyntaxNode, from: number, to: number, state: EditorState, out: Range<Decoration>[]) {
  if (from >= to) return;
  const tokens = scanInline(state.sliceDoc(from, to), from);
  for (const token of tokens) tokenDecorations(token, state, out);
  const taken = tokens.map((t) => ({ from: t.from, to: t.to }));
  const sub: Range<Decoration>[] = [];
  markDecorations(node, state, taken, sub);
  for (const d of sub) if (d.from >= from && d.to <= to) out.push(d);
}

function figureDecorations(node: SyntaxNode, state: EditorState, out: Range<Decoration>[]): boolean {
  const line = state.doc.lineAt(node.from);
  if (line.to < node.to || !line.text.includes("![")) return false;
  const fig = parseFigure(line.text, line.from);
  if (!fig) return false;
  const id = figureId(fig);
  const ref = id ? labelRef(id) : undefined;
  const name = refName("fig", language());
  const caption = plainCaption(fig.caption.text);
  const prefix = ref?.number ? `${name} ${ref.number}` : name;
  out.push(
    previewReplace(
      node.from,
      node.to,
      new FigureWidget(
        fig.src.text,
        caption ? `${prefix}: ${caption}` : prefix,
        figureAttribute(fig, "width") ?? "",
        store.get().dir ?? "",
        store.get().figures.includes(fig.src.text),
      ),
    ),
  );
  return true;
}

/** A paragraph, split at `:::` fence lines (the grammar reads a div without blank lines as one paragraph). */
function paragraphDecorations(node: SyntaxNode, state: EditorState, out: Range<Decoration>[]) {
  if (figureDecorations(node, state, out)) return;
  let segment = node.from;
  for (let pos = node.from; pos <= node.to; ) {
    const line = state.doc.lineAt(pos);
    const fence = line.text.includes(":::") ? divFence(line.text) : null;
    if (fence) {
      inlineDecorations(node, segment, Math.max(segment, line.from - 1), state, out);
      out.push(DIV_LINE.range(line.from));
      out.push(previewReplace(line.from, line.to, fence.open ? new FenceLabelWidget(fence.label, "div") : undefined));
      segment = line.to + 1;
    }
    pos = line.to + 1;
  }
  inlineDecorations(node, segment, node.to, state, out);
}

function headingDecorations(node: SyntaxNode, level: number, state: EditorState, out: Range<Decoration>[]) {
  out.push(HEADING_LINES[level - 1].range(state.doc.lineAt(node.from).from));
  let textFrom = node.from;
  for (let mark = node.getChild("HeaderMark"); mark; mark = mark.nextSibling) {
    if (mark.name !== "HeaderMark") continue;
    if (mark.from === node.from || mark.from <= textFrom) {
      const after = /^[ \t]*/.exec(state.sliceDoc(mark.to, node.to))![0].length;
      textFrom = mark.to + after;
      out.push(previewReplace(mark.from, textFrom));
    } else {
      const before = /[ \t]*$/.exec(state.sliceDoc(textFrom, mark.from))![0].length;
      out.push(previewReplace(mark.from - before, mark.to));
    }
  }
  inlineDecorations(node, textFrom, node.to, state, out);
}

function fencedDecorations(node: SyntaxNode, state: EditorState, out: Range<Decoration>[]) {
  const info = node.getChild("CodeInfo");
  const format = info ? rawFormat(state.sliceDoc(info.from, info.to)) : null;
  const first = state.doc.lineAt(node.from);
  const last = state.doc.lineAt(node.to);
  for (let n = first.number; n <= last.number; n++) {
    out.push((format ? RAW_LINE : CODE_LINE).range(state.doc.line(n).from));
  }
  if (!format) return;
  out.push(previewReplace(first.from, first.to, new FenceLabelWidget(format === "latex" || format === "tex" ? "LaTeX" : format, "raw")));
  const close = node.lastChild;
  if (last.number > first.number && close?.name === "CodeMark") out.push(previewReplace(last.from, last.to));
}

function containerDecorations(node: SyntaxNode, state: EditorState, out: Range<Decoration>[]) {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "QuoteMark") {
      const space = state.sliceDoc(child.to, child.to + 1) === " " ? 1 : 0;
      out.push(previewReplace(child.from, child.to + space));
    } else blockContent(child, state, out);
  }
}

function blockContent(node: SyntaxNode, state: EditorState, out: Range<Decoration>[]) {
  const name = node.name;
  if (name.startsWith("ATXHeading")) return headingDecorations(node, Number(name.slice(10)), state, out);
  if (name.startsWith("SetextHeading")) {
    out.push(HEADING_LINES[Number(name.slice(13)) - 1].range(node.from));
    return inlineDecorations(node, node.from, state.doc.lineAt(node.from).to, state, out);
  }
  switch (name) {
    case "Paragraph":
      return paragraphDecorations(node, state, out);
    case "FencedCode":
      return fencedDecorations(node, state, out);
    case "Blockquote": {
      const first = state.doc.lineAt(node.from).number;
      const last = state.doc.lineAt(node.to).number;
      for (let n = first; n <= last; n++) out.push(QUOTE_LINE.range(state.doc.line(n).from));
      return containerDecorations(node, state, out);
    }
    case "BulletList":
    case "OrderedList":
    case "ListItem":
      return containerDecorations(node, state, out);
  }
}

/** Every Writing-mode decoration of the top-level blocks touching `from`..`to`. */
export function buildRegion(state: EditorState, from: number, to: number): Range<Decoration>[] {
  const out: Range<Decoration>[] = [];
  for (const node of topBlocks(syntaxTree(state), from, to)) {
    const custom = blockDecorations({ name: node.name, from: node.from, to: node.to, state });
    if (custom) out.push(...custom);
    else blockContent(node, state, out);
  }
  return out;
}
