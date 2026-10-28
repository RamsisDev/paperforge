// The math under the cursor, the one change that writes an edited formula back, and the macros
// of preamble.tex. Pure functions apart from reading the syntax tree.

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { ChangeSpec, EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { scanInline, type Span } from "../syntax";

export interface MathSpan extends Span {
  display: boolean;
  /** `eq:x` of a trailing `{#eq:x}`, or "". */
  label: string;
  /** The formula between the delimiters, without surrounding whitespace. */
  inner: Span;
  tex: string;
}

/** The math token of `text` (starting at `base`) that holds `pos`, ends included. */
export function findMath(text: string, base: number, pos: number): MathSpan | null {
  for (const token of scanInline(text, base)) {
    if (token.from > pos) break;
    if (token.kind !== "math" || pos > token.to) continue;
    const src = text.slice(token.from - base, token.to - base);
    let a = token.display ? 2 : 1;
    let b = token.display ? src.lastIndexOf("$$") : src.length - 1;
    while (a < b && /\s/.test(src[a])) a++;
    while (b > a && /\s/.test(src[b - 1]) && src[b - 2] !== "\\") b--;
    return {
      from: token.from,
      to: token.to,
      display: token.display,
      label: token.label,
      inner: { from: token.from + a, to: token.from + b },
      tex: src.slice(a, b),
    };
  }
  return null;
}

const TEXT_BLOCK = /^(Paragraph|ATXHeading\d|SetextHeading\d|TableCell)$/;

/** The `$…$` or `$$…$$` around `pos`; math-looking text in code blocks and code spans is not math. */
export function mathAt(state: EditorState, pos: number): MathSpan | null {
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, pos + 1), 50) ?? syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (!TEXT_BLOCK.test(node.name)) continue;
      const math = findMath(state.sliceDoc(node.from, node.to), node.from, pos);
      if (math) return math;
      break;
    }
  }
  return null;
}

/** Replaces only the formula: delimiters, `{#eq:x}` and the text around stay as they are. */
export function mathChange(math: MathSpan, tex: string): ChangeSpec {
  // Pandoc inline math cannot span lines or start or end with a space.
  const insert = math.display ? tex : tex.replace(/\s*\n\s*/g, " ").trim();
  return { from: math.inner.from, to: math.inner.to, insert };
}

export interface MathEdit {
  /** The source formula. */
  original: string;
  /** MathLive's serialization of `original`, null until the field loaded. */
  baseline: string | null;
  /** MathLive's serialization of what the field shows now. */
  field: string | null;
  /** The raw LaTeX box, when it was the last thing the user edited. */
  raw: string | null;
}

/**
 * The formula to write back, or null when nothing really changed. MathLive normalizes LaTeX, so
 * its output is compared with its own reading of the original, never with the source text.
 */
export function editedTex(edit: MathEdit): string | null {
  if (edit.raw !== null) return edit.raw === edit.original ? null : edit.raw;
  if (edit.baseline === null || edit.field === null || edit.field === edit.baseline) return null;
  return edit.field;
}

export interface TexMacro {
  /** Without the backslash. */
  name: string;
  args: number;
  body: string;
}

/** The `{…}` group opening at `start` (after spaces), as [content, end], or null. */
function group(text: string, start: number): [string, number] | null {
  let i = start;
  while (/\s/.test(text[i] ?? "")) i++;
  if (text[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === "{") depth++;
    else if (text[j] === "}" && --depth === 0) return [text.slice(i + 1, j), j + 1];
  }
  return null;
}

/**
 * The `\newcommand`, `\renewcommand`, `\providecommand` and `\DeclareMathOperator` definitions
 * of a preamble that take no optional argument; a later definition of a name wins.
 */
export function preambleMacros(preamble: string): TexMacro[] {
  const text = preamble.replace(/(^|[^\\])%.*$/gm, "$1");
  const macros = new Map<string, TexMacro>();
  const command = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator)(\*?)/g;
  for (let m = command.exec(text); m; m = command.exec(text)) {
    let at = m.index + m[0].length;
    const braced = group(text, at);
    const bare = braced ? null : /^\s*\\([a-zA-Z]+)/.exec(text.slice(at));
    const name = braced ? /^\s*\\([a-zA-Z]+)\s*$/.exec(braced[0])?.[1] : bare?.[1];
    if (!name) continue;
    at = braced ? braced[1] : at + bare![0].length;
    if (m[1] === "DeclareMathOperator") {
      const body = group(text, at);
      if (body) macros.set(name, { name, args: 0, body: `\\operatorname${m[2]}{${body[0]}}` });
      continue;
    }
    const count = /^\s*\[(\d)\]/.exec(text.slice(at));
    if (count) at += count[0].length;
    if (/^\s*\[/.test(text.slice(at))) continue;
    const body = group(text, at);
    if (body) macros.set(name, { name, args: count ? Number(count[1]) : 0, body: body[0] });
  }
  return [...macros.values()];
}

export function katexMacros(macros: readonly TexMacro[]): Record<string, string> {
  return Object.fromEntries(macros.map((m) => [`\\${m.name}`, m.body]));
}

export function mathliveMacros(macros: readonly TexMacro[]): Record<string, { def: string; args: number; expand: boolean }> {
  return Object.fromEntries(macros.map((m) => [m.name, { def: m.body, args: m.args, expand: false }]));
}
