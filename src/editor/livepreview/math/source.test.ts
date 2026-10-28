import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { editedTex, findMath, katexMacros, mathAt, mathChange, mathliveMacros, preambleMacros, type MathEdit } from "./source";

const stateOf = (doc: string) => EditorState.create({ doc, extensions: markdown({ base: markdownLanguage }) });
/** `doc` with `|` marking the cursor: the math found there, as source slices. */
function at(marked: string) {
  const pos = marked.indexOf("|");
  const state = stateOf(marked.replace("|", ""));
  const math = mathAt(state, pos);
  return math && { whole: state.sliceDoc(math.from, math.to), inner: state.sliceDoc(math.inner.from, math.inner.to), display: math.display, label: math.label };
}
function applied(marked: string, tex: string) {
  const pos = marked.indexOf("|");
  const state = stateOf(marked.replace("|", ""));
  return state.update({ changes: mathChange(mathAt(state, pos)!, tex) }).state.doc.toString();
}

describe("mathAt", () => {
  it("finds inline math around the cursor, delimiters included", () => {
    expect(at("A $x|^2$ b")).toEqual({ whole: "$x^2$", inner: "x^2", display: false, label: "" });
    expect(at("A |$x$ b")?.inner).toBe("x");
    expect(at("A $x$| b")?.inner).toBe("x");
    expect(at("A $x$ |b")).toBeNull();
    expect(at("# Title $\\al|pha$")?.inner).toBe("\\alpha");
  });

  it("finds display math with its label, on one line or several", () => {
    expect(at("Text\n\n$$H(X) = |-\\sum p$$ {#eq:h}\n")).toEqual({
      whole: "$$H(X) = -\\sum p$$ {#eq:h}",
      inner: "H(X) = -\\sum p",
      display: true,
      label: "eq:h",
    });
    expect(at("$$\n  a |+ b\n  = c\n$$ {#eq:m}\n\nAfter")).toEqual({
      whole: "$$\n  a + b\n  = c\n$$ {#eq:m}",
      inner: "a + b\n  = c",
      display: true,
      label: "eq:m",
    });
    expect(at("$$x$$ {#eq:|y}")?.label).toBe("eq:y");
  });

  it("ignores escaped dollars and dollars in code", () => {
    expect(at("Costs \\$5 and |\\$6")).toBeNull();
    expect(at("Costs \\$5 and $|y$")?.inner).toBe("y");
    expect(at("Run `echo $H|OME$` now")).toBeNull();
    expect(at("```\n$x|$\n```\n")).toBeNull();
    expect(at("    $x|$ indented code\n")).toBeNull();
    expect(at("`$a$` and $b|$")?.inner).toBe("b");
  });

  it("matches findMath on a bare string", () => {
    expect(findMath("x $a$ y", 10, 13)?.inner).toEqual({ from: 13, to: 14 });
  });
});

describe("mathChange", () => {
  it("replaces only the formula and keeps delimiters, label and surrounding text", () => {
    expect(applied("See $|x$, then", "y^2")).toBe("See $y^2$, then");
    expect(applied("$$ a| $$ {#eq:a .x}\n", "\\frac{1}{2}")).toBe("$$ \\frac{1}{2} $$ {#eq:a .x}\n");
    expect(applied("$$\na |+ b\n$$ {#eq:m}\n", "c\n= d")).toBe("$$\nc\n= d\n$$ {#eq:m}\n");
  });

  it("keeps inline math on one line without edge spaces", () => {
    expect(applied("A $|x$ b", " p\n  + q ")).toBe("A $p + q$ b");
  });

  it("is one local change", () => {
    const state = stateOf("Before\n\n$$x$$ {#eq:x}\n\nAfter $y$\n");
    const change = mathChange(mathAt(state, 10)!, "z");
    expect(change).toEqual({ from: 10, to: 11, insert: "z" });
  });
});

describe("editedTex", () => {
  const edit = (e: Partial<MathEdit>): MathEdit => ({ original: "x^2", baseline: "x^{2}", field: "x^{2}", raw: null, ...e });
  it("ignores MathLive's normalization of an untouched formula", () => {
    expect(editedTex(edit({}))).toBeNull();
    expect(editedTex(edit({ baseline: null, field: null }))).toBeNull();
  });
  it("returns the field's LaTeX after a real edit, and nothing when it is undone", () => {
    expect(editedTex(edit({ field: "x^{3}" }))).toBe("x^{3}");
    expect(editedTex(edit({ field: "x^{2}" }))).toBeNull();
  });
  it("writes the raw box exactly when it was edited last", () => {
    expect(editedTex(edit({ raw: "x^2 " }))).toBe("x^2 ");
    expect(editedTex(edit({ raw: "x^2", field: "x^{3}" }))).toBeNull();
  });
});

describe("preambleMacros", () => {
  it("reads simple definitions with and without arguments", () => {
    const macros = preambleMacros(String.raw`
\usepackage{amsmath}
\newcommand{\R}{\mathbb{R}}
\newcommand\norm[1]{\left\lVert #1 \right\rVert}
\renewcommand*{\vec}[1]{\mathbf{#1}}
\providecommand{\half}{\frac{1}{2}}
\DeclareMathOperator{\Tr}{Tr}
\DeclareMathOperator*{\argmax}{arg\,max}
\newcommand{\opt}[2][x]{#1 #2}
% \newcommand{\commented}{no}
\newcommand{\R}{\mathbf{R}} % redefined
`);
    expect(macros).toEqual([
      { name: "R", args: 0, body: "\\mathbf{R}" },
      { name: "norm", args: 1, body: "\\left\\lVert #1 \\right\\rVert" },
      { name: "vec", args: 1, body: "\\mathbf{#1}" },
      { name: "half", args: 0, body: "\\frac{1}{2}" },
      { name: "Tr", args: 0, body: "\\operatorname{Tr}" },
      { name: "argmax", args: 0, body: "\\operatorname*{arg\\,max}" },
    ]);
  });

  it("keeps nested braces and escaped percent signs", () => {
    expect(preambleMacros("\\newcommand{\\pct}{50\\% {a{b}}}")).toEqual([{ name: "pct", args: 0, body: "50\\% {a{b}}" }]);
    expect(preambleMacros("\\newcommand{\\broken}{unclosed")).toEqual([]);
  });

  it("converts to KaTeX and MathLive dictionaries", () => {
    const macros = preambleMacros("\\newcommand{\\R}{\\mathbb{R}}\\newcommand{\\sq}[1]{#1^2}");
    expect(katexMacros(macros)).toEqual({ "\\R": "\\mathbb{R}", "\\sq": "#1^2" });
    expect(mathliveMacros(macros)).toEqual({
      R: { def: "\\mathbb{R}", args: 0, expand: false },
      sq: { def: "#1^2", args: 1, expand: false },
    });
  });
});
