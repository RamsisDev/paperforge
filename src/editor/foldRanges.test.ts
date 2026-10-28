import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { markdownFold } from "./foldRanges";

/** The fold at 1-based line `n`, as the 1-based first and last hidden line, or null. */
function fold(lines: string[], n: number): [number, number] | null {
  const s = EditorState.create({ doc: lines.join("\n"), extensions: markdown({ base: markdownLanguage }) });
  const tree = ensureSyntaxTree(s, s.doc.length, 5000)!;
  const range = markdownFold(s, s.doc.line(n).from, tree);
  if (!range) return null;
  expect(range.from).toBe(s.doc.line(n).to);
  return [s.doc.lineAt(range.from).number, s.doc.lineAt(range.to).number];
}

describe("markdown folding", () => {
  const doc = [
    "# Intro {#sec:intro}", // 1
    "", // 2
    "Text.", // 3
    "", // 4
    "## Background", // 5
    "More text.", // 6
    "", // 7
    "### Detail", // 8
    "Deep.", // 9
    "", // 10
    "## Method", // 11
    "", // 12
    "```python", // 13
    "# not a heading", // 14
    "```", // 15
    "", // 16
    "# Results", // 17
    "Done.", // 18
    "", // 19
    "", // 20
    "## Empty", // 21
  ];

  it("folds a heading down to the next heading of the same or a higher level", () => {
    expect(fold(doc, 1)).toEqual([1, 15]);
    expect(fold(doc, 5)).toEqual([5, 9]);
    expect(fold(doc, 8)).toEqual([8, 9]);
    expect(fold(doc, 11)).toEqual([11, 15]);
    expect(fold(doc, 17)).toEqual([17, 21]);
  });

  it("does not fold an empty section or plain lines", () => {
    expect(fold(doc, 21)).toBeNull();
    expect(fold(["## A", "## B", "text"], 1)).toBeNull();
    expect(fold(doc, 3)).toBeNull();
    expect(fold(["First line", "second line of the paragraph"], 1)).toBeNull();
  });

  it("ignores headings inside fenced code", () => {
    expect(fold(doc, 14)).toBeNull();
    expect(fold(["# A", "~~~", "# B", "~~~", "after"], 1)).toEqual([1, 5]);
  });

  it("folds fenced code and raw LaTeX blocks from their opening line", () => {
    expect(fold(doc, 13)).toEqual([13, 15]);
    expect(fold(doc, 15)).toBeNull();
    expect(fold(["```{=latex}", "\\newpage", "\\vspace{1em}", "```", "x"], 1)).toEqual([1, 4]);
  });

  it("folds $$ display math, not its closing line or one-line math", () => {
    const math = ["Where", "$$", "a + b", "$$ {#eq:sum}", "", "$$", "c", "$$", "", "$$x$$"];
    expect(fold(math, 2)).toEqual([2, 4]);
    expect(fold(math, 4)).toBeNull();
    expect(fold(math, 6)).toEqual([6, 8]);
    expect(fold(math, 8)).toBeNull();
    expect(fold(math, 10)).toBeNull();
  });

  it("folds ::: divs to their matching closing fence", () => {
    const divs = ["::: {.note}", "Outer.", "", "::: warning", "Inner.", ":::", "", "Tail.", ":::", "", "::: {.open}", "never closed"];
    expect(fold(divs, 1)).toEqual([1, 9]);
    expect(fold(divs, 4)).toEqual([4, 6]);
    expect(fold(divs, 6)).toBeNull();
    expect(fold(divs, 11)).toBeNull();
  });

  it("only folds Markdown", () => {
    const s = EditorState.create({ doc: "# Title\ntext" });
    expect(markdownFold(s, 0)).toBeNull();
  });
});
