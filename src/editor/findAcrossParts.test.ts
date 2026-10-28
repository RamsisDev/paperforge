import { describe, expect, it } from "vitest";
import {
  expandReplacement,
  findAcrossParts,
  findInText,
  markupZones,
  replaceInText,
  replacementChanges,
  type FindOptions,
} from "./findAcrossParts";

const opts = (query: string, extra: Partial<FindOptions> = {}): FindOptions => ({
  query,
  regex: false,
  matchCase: false,
  wholeWord: false,
  skipMarkup: false,
  ...extra,
});

const texts = (text: string, o: FindOptions) => findInText(text, o).map((m) => text.slice(m.from, m.to));

describe("findInText", () => {
  it("matches literally unless regex is on", () => {
    expect(texts("a.b axb a.b", opts("a.b"))).toEqual(["a.b", "a.b"]);
    expect(texts("a.b axb", opts("a.b", { regex: true }))).toEqual(["a.b", "axb"]);
  });

  it("ignores case unless match case is on", () => {
    expect(texts("Entropy entropy ENTROPY", opts("entropy"))).toHaveLength(3);
    expect(texts("Entropy entropy ENTROPY", opts("entropy", { matchCase: true }))).toEqual(["entropy"]);
  });

  it("whole word checks both edges, including accented letters", () => {
    const text = "cat catalog bobcat cat_x cat. café cat";
    expect(findInText(text, opts("cat", { wholeWord: true })).map((m) => m.from)).toEqual([0, 25, 35]);
    expect(texts("informació información", opts("información", { wholeWord: true }))).toEqual(["información"]);
    expect(texts("x-y x-yz", opts("-y", { wholeWord: true }))).toEqual(["-y"]);
  });

  it("whole word applies to regex matches", () => {
    expect(texts("the then other the", opts("th\\w*", { regex: true, wholeWord: true }))).toEqual(["the", "then", "the"]);
  });

  it("anchors ^ and $ to lines and skips empty matches", () => {
    const text = "alpha\nbeta alpha\nalpha";
    expect(findInText(text, opts("^alpha", { regex: true })).map((m) => m.line)).toEqual([0, 2]);
    expect(findInText(text, opts("x*", { regex: true }))).toEqual([]);
  });

  it("reports line, line start and line text", () => {
    const text = "one\ntwo foo\nthree foo foo";
    const [a, b, c] = findInText(text, opts("foo"));
    expect([a.line, a.lineFrom, a.lineText]).toEqual([1, 4, "two foo"]);
    expect([b.line, b.from - b.lineFrom, b.lineText]).toEqual([2, 6, "three foo foo"]);
    expect([c.line, c.from - c.lineFrom]).toEqual([2, 10]);
  });

  it("throws on an invalid regex; findAcrossParts reports it", () => {
    expect(() => findInText("x", opts("(", { regex: true }))).toThrow();
    const result = findAcrossParts([{ file: "a.md", content: "x" }], opts("(", { regex: true }));
    expect(result.error).toBeTruthy();
    expect(result.total).toBe(0);
  });
});

describe("skip math, code and citations", () => {
  const skip = (query: string, text: string) => texts(text, opts(query, { skipMarkup: true }));

  it("skips inline and display math", () => {
    expect(skip("x", "x and $x^2$ and $$\nx = 1\n$$ x")).toEqual(["x", "x"]);
    expect(skip("H", "$H(X)$ H")).toEqual(["H"]);
  });

  it("does not treat an escaped dollar as math", () => {
    expect(skip("costs", "\\$5 costs \\$6")).toEqual(["costs"]);
  });

  it("skips inline code and fenced code blocks", () => {
    const text = "use `foo` here\n\n```js\nfoo()\n```\n\n~~~~\nfoo\n~~~~\nfoo";
    expect(findInText(text, opts("foo", { skipMarkup: true })).map((m) => m.line)).toEqual([9]);
    expect(skip("foo", "``a `foo` b`` foo")).toEqual(["foo"]);
  });

  it("an unclosed fence runs to the end", () => {
    expect(skip("foo", "foo\n```\nfoo\nfoo")).toEqual(["foo"]);
  });

  it("skips bracketed and bare citations and cross references", () => {
    expect(skip("knuth", "Knuth [see @knuth1984, p. 3] and @knuth1984")).toEqual(["Knuth"]);
    expect(skip("fig", "the fig in @fig:example")).toEqual(["fig"]);
    expect(skip("example", "mail me@example.org")).toEqual(["example"]);
  });

  it("skips attributes", () => {
    expect(skip("intro", "# Intro {#sec:intro}")).toEqual(["Intro"]);
    expect(skip("wide", "![wide](f.png){#fig:x .wide width=80%}")).toEqual(["wide"]);
  });

  it("skips raw LaTeX commands, environments and raw blocks", () => {
    expect(skip("bold", "bold \\textbf{bold} \\LaTeX{} rules")).toEqual(["bold"]);
    expect(skip("rules", "\\LaTeX{} rules")).toEqual(["rules"]);
    expect(skip("cell", "cell\n\\begin{tabular}{ll}\ncell & cell\n\\end{tabular}\ncell")).toEqual(["cell", "cell"]);
    expect(skip("raw", "raw\n```{=latex}\n\\raw{raw}\n```\nraw")).toEqual(["raw", "raw"]);
  });

  it("drops a match that only partly overlaps a zone", () => {
    expect(skip("a $b", "a $b$ c")).toEqual([]);
  });

  it("zones are sorted and disjoint", () => {
    const zones = markupZones("$a$ `b` @c {#d} \\e{f}\n```\ng\n```\n$$h$$");
    for (let i = 1; i < zones.length; i++) expect(zones[i][0]).toBeGreaterThanOrEqual(zones[i - 1][1]);
    expect(zones).toHaveLength(7);
  });
});

describe("findAcrossParts", () => {
  const parts = [
    { file: "a.md", content: "the cat\nthe dog" },
    { file: "b.md", content: "nothing" },
    { file: "c.md", content: "the end" },
  ];

  it("groups matches by part in reading order", () => {
    const result = findAcrossParts(parts, opts("the"));
    expect(result.parts.map((p) => [p.file, p.matches.length])).toEqual([
      ["a.md", 2],
      ["c.md", 1],
    ]);
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("stops at the limit", () => {
    const result = findAcrossParts(parts, opts("the"), 2);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("an empty query finds nothing", () => {
    expect(findAcrossParts(parts, opts(""))).toEqual({ parts: [], total: 0, truncated: false, error: null });
  });
});

describe("replace", () => {
  it("replaces literally, without expanding $ in a plain search", () => {
    expect(replaceInText("a b a", opts("a"), "$1")).toBe("$1 b $1");
  });

  it("expands numbered and named groups, $& and $$", () => {
    const re = opts("(\\w+)@(?<host>\\w+)", { regex: true });
    expect(replaceInText("ada@lab, alan@uni", re, "$2:$1 [$<host>] $& $$")).toBe("lab:ada [lab] ada@lab $, uni:alan [uni] alan@uni $");
  });

  it("follows String.replace for out-of-range groups", () => {
    const re = opts("(a)(b)", { regex: true });
    for (const template of ["$12", "$3", "$0", "$<x>", "$1$2$1"]) {
      expect(replaceInText("ab", re, template)).toBe("ab".replace(/(a)(b)/g, template));
    }
    const [match] = findInText("ab", re);
    expect(expandReplacement("$<x>", match, "ab", true)).toBe("$<x>");
  });

  it("keeps offsets right with several matches per line and growing or shrinking text", () => {
    const text = "aa xx aa\nxx aa xx aa\naa";
    expect(replaceInText(text, opts("aa"), "BBBB")).toBe("BBBB xx BBBB\nxx BBBB xx BBBB\nBBBB");
    expect(replaceInText(text, opts("aa"), "")).toBe(" xx \nxx  xx \n");
    expect(replaceInText(text, opts("(a)a", { regex: true }), "<$1>")).toBe("<a> xx <a>\nxx <a> xx <a>\n<a>");
  });

  it("emits one local change per match", () => {
    const text = "x one x two x";
    const changes = replacementChanges(text, findInText(text, opts("x")), "y", false);
    expect(changes).toEqual([
      { from: 0, to: 1, insert: "y" },
      { from: 6, to: 7, insert: "y" },
      { from: 12, to: 13, insert: "y" },
    ]);
  });

  it("leaves skipped zones untouched", () => {
    expect(replaceInText("cat $cat$ `cat` @cat cat", opts("cat", { skipMarkup: true }), "dog")).toBe("dog $cat$ `cat` @cat dog");
  });
});
