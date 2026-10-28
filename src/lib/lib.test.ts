import { describe, expect, it } from "vitest";
import { parseBib, shortAuthors } from "./bib";
import { headings, labels, wordCount } from "./outline";
import { bestLine, words } from "./textmatch";

describe("parseBib", () => {
  const source = `% comment
@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {\\TeX}book},
  year      = 1984
}

@string{ieee = "IEEE"}
@article{shannon1948,
  author  = "Claude E. Shannon",
  title   = {A {Mathematical} Theory of {Communication}},
  year    = {1948}
}`;

  it("reads keys, cleaned fields and header lines", () => {
    const entries = parseBib(source);
    expect(entries.map((e) => e.key)).toEqual(["knuth1984", "shannon1948"]);
    expect(entries[0]).toMatchObject({ type: "book", title: "The TeXbook", year: "1984", line: 2 });
    expect(entries[1]).toMatchObject({ author: "Claude E. Shannon", title: "A Mathematical Theory of Communication", line: 9 });
  });

  it("survives an unterminated entry", () => {
    expect(parseBib("@misc{a, title = {never closed")[0]).toMatchObject({ key: "a", title: "never closed" });
  });

  it("shortens author lists", () => {
    expect(shortAuthors("Donald E. Knuth")).toBe("Knuth");
    expect(shortAuthors("Knuth, Donald and Lamport, Leslie")).toBe("Knuth & Lamport");
    expect(shortAuthors("A One and B Two and C Three")).toBe("One et al.");
  });
});

describe("outline", () => {
  const doc = "# Intro {#sec:intro}\n\ntext\n\n```md\n# not a heading\n```\n\n## Results\n\n![x](a.png){#fig:a}\n\n$$x$$ {#eq:e}\n";

  it("lists headings outside code fences", () => {
    expect(headings(doc)).toEqual([
      { level: 1, text: "Intro", line: 0, id: "sec:intro" },
      { level: 2, text: "Results", line: 8, id: null },
    ]);
  });

  it("collects reference labels by kind", () => {
    expect(labels(doc)).toEqual({ fig: ["fig:a"], tbl: [], eq: ["eq:e"], sec: ["sec:intro"] });
  });

  it("counts prose words only", () => {
    expect(wordCount("# Title\n\nHello *big* world.\n\n```\ncode here\n```\n$$a+b$$")).toBe(4);
  });
});

describe("bestLine", () => {
  const md = [
    "# Introduction {#sec:intro}",
    "",
    "Write your paper in **Markdown** and PaperForge typesets it with the template you pick.",
    "Cite with `[@key]` [@knuth1984; @lamport1994] or in the text: @shannon1948 showed that",
    "information can be measured. Refer to @sec:method and @eq:entropy.",
  ];

  it("strips markup from both sides", () => {
    expect(words("Write **Markdown** \\citep{a} $x$")).toEqual(["write", "markdown"]);
  });

  it("maps a generated paper.tex line back to Markdown", () => {
    const tex = "Cite with \\texttt{{[}@key{]}} \\citep{knuth1984, lamport1994} or in the text: \\citet{shannon1948} showed that";
    expect(bestLine(tex, md)?.line).toBe(3);
  });

  it("maps PDF text with hyphenation and numbering back to Markdown", () => {
    expect(bestLine("with the template you pick. Cite with [@key] [1, 2] or in the", md)?.line).toBe(2);
  });

  it("breaks ties between neighbouring lines with the clicked word", () => {
    const pdfLine = "showed that information can be measured. Refer to 2, 1, 1 and (1).";
    expect(bestLine(pdfLine, md, "measured")?.line).toBe(4);
  });

  it("rejects weak matches", () => {
    expect(bestLine("completely unrelated sentence", md)).toBeNull();
  });
});
