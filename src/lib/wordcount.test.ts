import { beforeEach, describe, expect, it } from "vitest";
import { wordCount } from "./wordcount";
import { goalProgress, sessionWords, setWordGoals, wordGoals } from "./wordGoals";

describe("word count", () => {
  it("counts prose words, hyphenated and contracted words once", () => {
    expect(wordCount("# Title\n\nHello *big* world, it’s well-known.")).toBe(6);
    expect(wordCount("")).toBe(0);
  });

  it("skips math, code and raw LaTeX blocks", () => {
    const text = [
      "One two.",
      "```python",
      "print('hidden words here')",
      "```",
      "~~~",
      "more hidden",
      "~~~",
      "```{=latex}",
      "\\vspace{1em} hidden",
      "```",
      "$$",
      "a + b = c",
      "$$ {#eq:sum}",
      "\\begin{figure}[ht] hidden \\end{figure}",
      "three",
    ];
    expect(wordCount(text.join("\n"))).toBe(3);
  });

  it("skips inline math, code, citations, references and attributes", () => {
    expect(wordCount("Let $x + y$ be `code here` as in [@knuth1984, p. 3] and @fig:plot.")).toBe(5);
    expect(wordCount("# Intro {#sec:intro}\n\n[Note]{.smallcaps} it costs $5 and $10.")).toBe(7);
    expect(wordCount("See -@lamport94 now")).toBe(2);
  });

  it("skips link targets, URLs, HTML, comments and footnote markers, keeping captions", () => {
    expect(wordCount("![A small plot](figures/plot.png){#fig:plot width=50%}")).toBe(3);
    expect(wordCount("Read [the docs](https://example.com/a-b) or https://foo.org/x now.")).toBe(5);
    expect(wordCount("Kept <span class=\"x\">inside</span> <!-- not this\nnor this --> end[^1].")).toBe(3);
  });

  it("keeps the prose argument of formatting commands and drops other commands", () => {
    expect(wordCount("A \\textbf{bold claim} and \\emph{this}.\\newpage\\vspace{2em}\\cite{key} done")).toBe(6);
  });

  it("drops ::: div fences but keeps their content", () => {
    expect(wordCount("::: {.note}\nInside the note.\n:::\n::: warning\nCareful\n:::")).toBe(4);
  });
});

describe("word goals", () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    } as Storage;
  });

  it("stores goals per project and forgets cleared ones", () => {
    setWordGoals("/a", { total: 5000, session: null });
    setWordGoals("/b", { total: null, session: 500.4 });
    expect(wordGoals("/a")).toEqual({ total: 5000, session: null });
    expect(wordGoals("/b")).toEqual({ total: null, session: 500 });
    expect(wordGoals("/a")).toBe(wordGoals("/a"));
    expect(JSON.parse(localStorage.getItem("paperforge.wordGoals")!)).toEqual({
      "/a": { total: 5000, session: null },
      "/b": { total: null, session: 500 },
    });
    setWordGoals("/a", { total: 0, session: -3 });
    expect(wordGoals("/a")).toEqual({ total: null, session: null });
    expect(Object.keys(JSON.parse(localStorage.getItem("paperforge.wordGoals")!))).toEqual(["/b"]);
    expect(wordGoals(null)).toEqual({ total: null, session: null });
  });

  it("measures the session from the first count and progress from 0 to 1", () => {
    expect(sessionWords("/s", 1200)).toBe(0);
    expect(sessionWords("/s", 1340)).toBe(140);
    expect(sessionWords("/s", 1100)).toBe(0);
    expect(goalProgress(1240, 5000)).toBeCloseTo(0.248);
    expect(goalProgress(6000, 5000)).toBe(1);
  });
});
