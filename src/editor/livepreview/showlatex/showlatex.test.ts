import { history, isolateHistory, undo } from "@codemirror/commands";
import { EditorState, Text, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { generatedLine, generatedSpot, rawLatexChange } from "./model";

const PART = [
  "# Method {#sec:method}",
  "",
  "Inline math, and **bold**",
  "on two lines.",
  "",
  "$$",
  "H(X) = -\\sum p",
  "$$ {#eq:entropy}",
  "",
  "After.",
].join("\n");

describe("convert to raw LaTeX", () => {
  const block = { markdownFrom: 3, markdownTo: 4, latex: "Inline math, and \\textbf{bold}\non two lines." };

  it("replaces exactly the block's lines with a latex fence", () => {
    const doc = Text.of(PART.split("\n"));
    const change = rawLatexChange(doc, block);
    expect(change).toEqual({
      from: doc.line(3).from,
      to: doc.line(4).to,
      insert: "```{=latex}\nInline math, and \\textbf{bold}\non two lines.\n```",
    });
    const after = doc.replace(change.from, change.to, Text.of(change.insert.split("\n"))).toString();
    expect(after).toBe(PART.replace("Inline math, and **bold**\non two lines.", change.insert));
    expect(after.split("\n").slice(1, 7)).toEqual(["", "```{=latex}", "Inline math, and \\textbf{bold}", "on two lines.", "```", ""]);
  });

  it("is one undoable step", () => {
    let state = EditorState.create({ doc: PART, extensions: history() });
    state = state.update({ changes: { from: 0, insert: "x" } }).state;
    state = state.update({
      changes: rawLatexChange(state.doc, { ...block, markdownFrom: 3, markdownTo: 4 }),
      annotations: isolateHistory.of("full"),
    }).state;
    expect(state.doc.toString()).toContain("```{=latex}");
    undo({ state, dispatch: (tr: Transaction) => (state = tr.state) });
    expect(state.doc.toString()).toBe(`x${PART}`);
  });

  it("uses a fence longer than any backtick run starting a LaTeX line", () => {
    const doc = Text.of(PART.split("\n"));
    const { insert } = rawLatexChange(doc, { markdownFrom: 10, markdownTo: 10, latex: "\\begin{verbatim}\n```\n\\end{verbatim}" });
    expect(insert).toBe("````{=latex}\n\\begin{verbatim}\n```\n\\end{verbatim}\n````");
  });
});

const GENERATED = Text.of(
  [
    "\\begin{document}", // 1
    "%PF-PART:sections/intro.md", // 2
    "%PF:1", // 3
    "", // 4
    "\\chapter{Intro}", // 5
    "%PF-PART-END", // 6
    "%PF-PART:sections/method.md", // 7
    "%PF:1", // 8
    "", // 9
    "\\section{Method}\\label{sec:method}", // 10
    "", // 11
    "%PF:3", // 12
    "", // 13
    "Inline math, and \\textbf{bold}", // 14
    "on two lines.", // 15
    "", // 16
    "%PF:6", // 17
    "", // 18
    "\\begin{equation}H(X) = -\\sum p\\label{eq:entropy}\\end{equation}", // 19
    "", // 20
    "%PF:10", // 21
    "", // 22
    "After.", // 23
    "%PF-PART-END", // 24
    "\\bibliography{refs}", // 25
    "\\end{document}", // 26
  ],
);

describe("generated LaTeX view", () => {
  it("maps a generated line to its part and Markdown line", () => {
    const spot = (line: number) => generatedSpot(GENERATED, line);
    expect(spot(5)).toEqual({ part: "sections/intro.md", line: 1 });
    expect(spot(10)).toEqual({ part: "sections/method.md", line: 1 });
    expect(spot(14)).toEqual({ part: "sections/method.md", line: 3 });
    expect(spot(15)).toEqual({ part: "sections/method.md", line: 4 });
    // The marker and the blank line after it belong to the block.
    expect(spot(12)).toEqual({ part: "sections/method.md", line: 3 });
    // A one-line equation for a three-line Markdown block stays at its first line.
    expect(spot(19)).toEqual({ part: "sections/method.md", line: 6 });
    // Never past the next block.
    expect(spot(20)).toEqual({ part: "sections/method.md", line: 7 });
    expect(spot(23)).toEqual({ part: "sections/method.md", line: 10 });
    expect(spot(7)).toEqual({ part: "sections/method.md", line: 1 });
    expect(spot(1)).toBeNull();
    expect(spot(24)).toBeNull();
    expect(spot(25)).toBeNull();
  });

  it("finds the block of a Markdown line in the generated view", () => {
    expect(generatedLine(GENERATED, "sections/method.md", 4)).toEqual({ marker: 12, line: 15 });
    expect(generatedLine(GENERATED, "sections/method.md", 3)).toEqual({ marker: 12, line: 14 });
    expect(generatedLine(GENERATED, "sections/method.md", 8)).toEqual({ marker: 17, line: 19 });
    expect(generatedLine(GENERATED, "sections/method.md", 99)).toEqual({ marker: 21, line: 23 });
    expect(generatedLine(GENERATED, "sections/intro.md", 1)).toEqual({ marker: 3, line: 5 });
    expect(generatedLine(GENERATED, "sections/other.md", 1)).toBeNull();
  });
});
