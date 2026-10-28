import { language, syntaxTree } from "@codemirror/language";
import type { EditorState, Line } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";

export interface FoldRange {
  from: number;
  to: number;
}

/** Longest `$$` math or `:::` div, in lines, scanned for its closing line. */
const MAX_BLOCK_LINES = 2000;

const DIV_OPEN = /^ {0,3}:{3,}\s*[^\s:]/;
const DIV_CLOSE = /^ {0,3}:{3,}\s*$/;
const MATH_OPEN = /^ {0,3}\$\$/;

/** Blocks whose lines are never headings, math or divs. */
const CODE_NODES = new Set(["CodeBlock", "HTMLBlock", "CommentBlock", "ProcessingInstructionBlock"]);

function headingLevel(name: string): number {
  const m = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
  return m ? Number(m[1]) : 0;
}

/** Only these first characters can start a foldable line, which keeps the gutter cheap. */
function mayFold(text: string): boolean {
  const c = text.trimStart().charCodeAt(0);
  return c === 35 /* # */ || c === 96 /* ` */ || c === 126 /* ~ */ || c === 36 /* $ */ || c === 58 /* : */;
}

function range(from: number, to: number): FoldRange | null {
  return to > from ? { from, to } : null;
}

/** From the heading's line end to the last block before the next heading of the same or a higher level. */
function sectionFold(state: EditorState, heading: SyntaxNode, level: number): FoldRange | null {
  let last = heading;
  for (let next = heading.nextSibling; next; next = next.nextSibling) {
    const nextLevel = headingLevel(next.name);
    if (nextLevel && nextLevel <= level) break;
    last = next;
  }
  return last === heading ? null : range(state.doc.lineAt(heading.to).to, last.to);
}

function closingLine(state: EditorState, open: Line, closes: (text: string) => boolean): FoldRange | null {
  const end = Math.min(state.doc.lines, open.number + MAX_BLOCK_LINES);
  for (let n = open.number + 1; n <= end; n++) {
    const line = state.doc.line(n);
    if (closes(line.text)) return range(open.to, line.to);
  }
  return null;
}

/** `$$` display math and `:::` fenced divs, which the Markdown parser reads as paragraphs. */
function blockFold(state: EditorState, line: Line, block: SyntaxNode | null): FoldRange | null {
  if (MATH_OPEN.test(line.text)) {
    if (line.text.trimStart().slice(2).includes("$$")) return null;
    // A `$$` line after an odd number of `$$` in its paragraph closes the math instead.
    if (block?.name === "Paragraph" && (state.sliceDoc(block.from, line.from).match(/\$\$/g)?.length ?? 0) % 2 === 1) return null;
    return closingLine(state, line, (text) => text.includes("$$"));
  }
  if (DIV_OPEN.test(line.text)) {
    let depth = 1;
    return closingLine(state, line, (text) => {
      if (DIV_CLOSE.test(text)) return --depth === 0;
      if (DIV_OPEN.test(text)) depth++;
      return false;
    });
  }
  return null;
}

/**
 * The range that folding the line at `lineFrom` hides, in Markdown: an ATX heading folds its
 * section; fenced code (raw ```` ```{=latex} ```` included), `$$` math and `:::` divs fold their
 * body and closing line. `tree` defaults to the state's current, possibly partial, syntax tree.
 */
export function markdownFold(state: EditorState, lineFrom: number, tree: Tree = syntaxTree(state)): FoldRange | null {
  const line = state.doc.lineAt(lineFrom);
  if (!mayFold(line.text) || state.facet(language)?.name !== "markdown" || tree.length < line.to) return null;
  let block: SyntaxNode | null = null;
  for (let node: SyntaxNode | null = tree.resolve(line.to, -1); node && !node.type.isTop; node = node.parent) {
    const level = headingLevel(node.name);
    if (level) return node.from >= line.from && node.name.startsWith("ATX") ? sectionFold(state, node, level) : null;
    if (node.name === "FencedCode") return node.from >= line.from ? range(line.to, node.to) : null;
    if (CODE_NODES.has(node.name)) return null;
    block = node;
  }
  return blockFold(state, line, block);
}
