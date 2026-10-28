import { describe, expect, it } from "vitest";
import type { Part, TocEntry } from "./api";
import { parseBib, shortAuthors } from "./bib";
import { locate } from "./diagnostics";
import { headings, labels, wordCount } from "./outline";
import {
  LONG_PART_WORDS,
  allText,
  bestLineInParts,
  findHeading,
  findInParts,
  isLongPart,
  partInfo,
  partStem,
  partTitle,
  splitLevel,
  totalWords,
} from "./parts";
import { bestLine, words } from "./textmatch";
import { arabicPage, pdfPageIndex, tocIndents, tocLists } from "./toc";

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

const PARTS: Part[] = [
  {
    file: "sections/introduction.md",
    content:
      "# Introduction {#sec:intro}\n\nWrite your paper in **Markdown** and PaperForge typesets it.\nCite with [@knuth1984] or @shannon1948 showed that\ninformation can be measured.\n",
  },
  {
    file: "sections/method.md",
    content:
      "# Method {#sec:method}\n\nInline math works as usual, $H(X) \\ge 0$, and labeled display equations are numbered:\n\n## Results\n\n![A sample figure.](figures/example.png){#fig:example}\n",
  },
  { file: "sections/notes.md", content: "Plain text without a heading.\n" },
];

describe("parts", () => {
  it("joins every part in reading order", () => {
    expect(allText(PARTS).split("\n\n# ").length).toBe(2);
    expect(labels(allText(PARTS))).toEqual({ fig: ["fig:example"], tbl: [], eq: [], sec: ["sec:intro", "sec:method"] });
  });

  it("titles a part by its first heading, else by its file name", () => {
    expect(PARTS.map(partTitle)).toEqual(["Introduction", "Method", "notes"]);
    expect(partTitle({ file: "a.md", content: "```\n# code\n```\n## Real {#sec:x}\n" })).toBe("Real");
    expect(partStem("sections/01-intro.md")).toBe("01-intro");
  });

  it("counts words per part and in total", () => {
    expect(partInfo(PARTS[2]).words).toBe(5);
    expect(totalWords(PARTS)).toBe(PARTS.reduce((n, p) => n + wordCount(p.content), 0));
    expect(partInfo(PARTS[1]).levels.slice(1, 3)).toEqual([1, 1]);
  });

  it("finds the best line across parts", () => {
    const tex = "Inline math works as usual, $H(X) \\ge 0$, and labeled display equations are numbered:";
    expect(bestLineInParts(tex, PARTS)).toMatchObject({ file: "sections/method.md", line: 2 });
    expect(bestLineInParts("showed that information can be measured", PARTS, "measured")).toMatchObject({
      file: "sections/introduction.md",
      line: 3,
    });
    expect(bestLineInParts("nothing like this anywhere", PARTS)).toBeNull();
  });

  it("finds literal text and headings across parts", () => {
    expect(findInParts(PARTS, "@shannon1948")).toEqual({ file: "sections/introduction.md", line: 3 });
    expect(findInParts(PARTS, "@missing")).toBeNull();
    expect(findHeading(PARTS, "Results")).toEqual({ file: "sections/method.md", line: 4 });
    expect(findHeading(PARTS, "introduction")).toEqual({ file: "sections/introduction.md", line: 0 });
  });

  it("suggests splitting long or crowded parts only when a split is possible", () => {
    const crowded = { file: "a.md", content: "# A\n\nx\n\n# B\n\ny\n\n# C\n\nz\n" };
    const subsections = { file: "b.md", content: "# A\n\n## One\n\n## Two\n" };
    const long = { file: "c.md", content: `# Only one\n\n${"word ".repeat(LONG_PART_WORDS + 1)}\n` };
    expect(splitLevel(crowded)).toBe(1);
    expect(splitLevel(subsections)).toBe(2);
    expect(splitLevel(long)).toBeNull();
    expect(isLongPart(crowded)).toBe(true);
    expect(isLongPart(subsections)).toBe(false);
    expect(isLongPart(long)).toBe(false);
  });
});

describe("locate", () => {
  const base = { severity: "warning", stage: "latex", file: "part-method.tex", line: 3 } as const;

  it("maps a diagnostic to a line of the part it came from", () => {
    const [d] = locate(
      [{ ...base, message: "Overfull \\hbox", source: "Inline math works as usual, $H(X) \\ge 0$, and labeled", part: "sections/method.md" }],
      PARTS,
    );
    expect(d).toMatchObject({ file: "sections/method.md", line: 2 });
  });

  it("falls back to the top of the part, then to a search across parts", () => {
    const [top, cited, bib, tex, none] = locate(
      [
        { ...base, message: "Something odd", source: "\\unrelated{}", part: "sections/method.md" },
        { ...base, file: "paper.tex", message: "Citation `shannon1948' on page 1 undefined", source: null, part: null },
        { ...base, stage: "bibtex", file: "refs.bib", line: 7, message: "empty journal", source: null, part: null },
        { ...base, file: "paper.tex", line: 12, message: "Undefined control sequence", source: "\\foo", part: null },
        { ...base, file: null, line: null, message: "Rerun", source: null, part: null },
      ],
      PARTS,
    );
    expect(top).toMatchObject({ file: "sections/method.md", line: 0 });
    expect(cited).toMatchObject({ file: "sections/introduction.md", line: 3 });
    expect(bib).toMatchObject({ file: "refs.bib", line: 6 });
    expect(tex).toMatchObject({ file: "paper.tex", line: 11 });
    expect(none).toMatchObject({ file: null, line: null });
  });

  it("searches every part when the diagnostic has no part", () => {
    const [d] = locate([{ ...base, file: "paper.tex", message: "x", source: "labeled display equations are numbered", part: null }], PARTS);
    expect(d).toMatchObject({ file: "sections/method.md", line: 2 });
  });
});

describe("toc", () => {
  const entry = (list: TocEntry["list"], level: string, depth: number, number: string, title: string, page: string): TocEntry => ({
    list,
    level,
    depth,
    number,
    title,
    page,
  });
  const toc = [
    entry("toc", "chapter", 0, "1", "Introduction", "1"),
    entry("toc", "section", 1, "1.1", "Background", "2"),
    entry("lof", "figure", 1, "1.1", "A sample figure.", "3"),
    entry("toc", "chapter", 0, "", "Bibliography", "9"),
    entry("lot", "table", 1, "1.1", "Results.", "4"),
  ];

  it("splits entries into contents, figures and tables", () => {
    const lists = tocLists(toc);
    expect(lists.toc.map((e) => e.title)).toEqual(["Introduction", "Background", "Bibliography"]);
    expect(lists.lof).toHaveLength(1);
    expect(lists.lot).toHaveLength(1);
  });

  it("indents relative to the shallowest entry", () => {
    expect(tocIndents(tocLists(toc).toc)).toEqual([0, 1, 0]);
    expect(tocIndents([entry("toc", "section", 1, "1", "A", "1"), entry("toc", "subsection", 2, "1.1", "B", "1")])).toEqual([0, 1]);
  });

  it("reads arabic pages and maps them to PDF pages", () => {
    expect(arabicPage("12")).toBe(12);
    expect(arabicPage("iv")).toBeNull();
    expect(pdfPageIndex(1, ["i", "ii", "1", "2"], 4)).toBe(2);
    expect(pdfPageIndex(3, null, 4)).toBe(2);
    expect(pdfPageIndex(9, null, 4)).toBeNull();
  });
});
