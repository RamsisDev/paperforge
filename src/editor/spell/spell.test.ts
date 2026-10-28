import { readFileSync } from "node:fs";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it } from "vitest";
import { SpellEngine } from "./engine";
import { isCheckable, isListed, mergeWords, spellTokens } from "./tokens";

function words(text: string, from = 0, to = text.length): string[] {
  const tree = markdownLanguage.parser.parse(text);
  return spellTokens(text.slice(from, to), from, tree).map((t) => t.word);
}

describe("spell tokens", () => {
  it("skips math, code, citations, attributes, URLs, raw LaTeX and comments", () => {
    const text = [
      "# Introdution {#sec:intro}",
      "",
      "Some txet with $x + y = z$ math, `inline cdoe`, and @knuth1984 or [@lamport94, p. 3].",
      "See <https://exampel.com>, www.foo.org and a [linkk](http://bar.baz/qux \"Titel\").",
      "Raw \\textbf{boldd} and \\cite{keyy} in \\begin{figure}[ht] here, mail me@host.org.",
      "<!-- a commment -->",
      "",
      "```{=latex}",
      "\\vspace{1em} hiddn",
      "```",
      "",
      "$$",
      "\\int fooo",
      "$$",
      "",
      "    indented cdoe",
      "",
      "::: {.note lang=en}",
      "NASA uses PaperForge, v2 and snake_case. It’s [spaan]{.smallcaps} fine.",
      ":::",
    ].join("\n");
    expect(words(text)).toEqual([
      "Introdution",
      "Some",
      "txet",
      "with",
      "math",
      "and",
      "or",
      "See",
      "and",
      "linkk",
      "Titel",
      "Raw",
      "boldd",
      "and",
      "in",
      "here",
      "mail",
      "uses",
      "and",
      "It’s",
      "spaan",
      "fine",
    ]);
  });

  it("reports document positions for a slice", () => {
    const text = "First line here.\nSecond lyne $a$ there.\n";
    const from = text.indexOf("Second");
    const tree = markdownLanguage.parser.parse(text);
    const tokens = spellTokens(text.slice(from), from, tree);
    expect(tokens.map((t) => t.word)).toEqual(["Second", "lyne", "there"]);
    for (const t of tokens) expect(text.slice(t.from, t.to)).toBe(t.word);
  });

  it("leaves out acronyms, camelCase names, numbers and single letters", () => {
    expect(["word", "Word", "it's"].every(isCheckable)).toBe(true);
    expect(["a", "NASA", "PaperForge", "v2", "snake_case", "2024"].some(isCheckable)).toBe(false);
  });
});

describe("personal dictionaries", () => {
  it("merges project, user and ignored words", () => {
    const merged = mergeWords(["PaperForge", " pandoc ", ""], ["It’s"], new Set(["tectonic"]));
    expect([...merged].sort()).toEqual(["It's", "PaperForge", "pandoc", "tectonic"]);
  });

  it("follows Hunspell casing for listed words", () => {
    const listed = mergeWords(["pandoc", "Zotero", "it's"]);
    expect(isListed("pandoc", listed)).toBe(true);
    expect(isListed("Pandoc", listed)).toBe(true);
    expect(isListed("PANDOC", listed)).toBe(true);
    expect(isListed("Zotero", listed)).toBe(true);
    expect(isListed("ZOTERO", listed)).toBe(true);
    expect(isListed("zotero", listed)).toBe(false);
    expect(isListed("It’s", listed)).toBe(true);
    expect(isListed("pandocs", listed)).toBe(false);
  });
});

describe("spell engine", () => {
  const aff = "SET UTF-8\nTRY esianrtolcdugmphbyfvkwz'\n\nSFX S Y 1\nSFX S 0 s .\n";
  const dic = "5\npaper/S\nforge\nword/S\nspell\nit's\n";
  const engine = new SpellEngine(aff, dic);

  it("flags unknown words and accepts affixed and capitalized forms", () => {
    expect(engine.misspelled(["paper", "papers", "Paper", "PAPER", "forge", "papr", "forges", "It’s"])).toEqual([
      "papr",
      "forges",
    ]);
  });

  it("suggests at most five corrections", () => {
    expect(engine.suggest("papr")).toContain("paper");
    expect(engine.suggest("wrod")).toContain("word");
    expect(engine.suggest("sepll").length).toBeLessThanOrEqual(5);
  });

  it("checks a paragraph end to end, minus listed words", () => {
    const text = "A papr on spell forge with $x$ and Wrods.";
    const tree = markdownLanguage.parser.parse(text);
    const listed = mergeWords(["on", "with", "and"]);
    const candidates = spellTokens(text, 0, tree).filter((t) => !isListed(t.word, listed));
    const bad = engine.misspelled(candidates.map((t) => t.word));
    expect(bad).toEqual(["papr", "Wrods"]);
    expect(engine.suggest("Wrods")).toContain("Words");
  });

  it("loads the bundled English dictionary", () => {
    const dir = new URL("../../../node_modules/dictionary-en/", import.meta.url);
    const en = new SpellEngine(readFileSync(new URL("index.aff", dir), "utf8"), readFileSync(new URL("index.dic", dir), "utf8"));
    expect(en.misspelled(["receive", "recieve", "paragraphs", "Typesetting"])).toEqual(["recieve"]);
    expect(en.suggest("recieve")).toContain("receive");
  });
});
