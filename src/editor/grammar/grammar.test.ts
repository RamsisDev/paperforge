import { markdownLanguage } from "@codemirror/lang-markdown";
import { forEachDiagnostic, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { EditorState, Text, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { backgroundDiagnostics, publishSpec, settle } from "../backgroundLint";
import { dialectFor } from "./dialects";
import { findGrammar, GRAMMAR_SOURCE, lintKey, type LintTexts } from "./diagnostics";
import { harperLinter } from "./harper";
import type { GrammarLint } from "./protocol";
import { proseBlocks, proseRanges, toDocument } from "./prose";

const parse = (text: string) => markdownLanguage.parser.parse(text);
const whole = (text: string) => [{ from: 0, to: text.length }];

/** Flags every "an" before a consonant and every "I has", the way Harper reports them. */
const fakeLinter: LintTexts = async (texts) =>
  texts.map((text) => {
    const lints: GrammarLint[] = [];
    for (const m of text.matchAll(/\b[Aa]n(?= [b-df-hj-np-tv-z])/g)) {
      lints.push({
        start: m.index,
        end: m.index + 2,
        kind: "Miscellaneous",
        message: "Incorrect indefinite article.",
        problem: m[0],
        suggestions: [{ kind: "replace", text: "a" }],
      });
    }
    for (const m of text.matchAll(/(?<=\bI )has\b/g)) {
      lints.push({
        start: m.index,
        end: m.index + 3,
        kind: "Agreement",
        message: "The form of the verb must agree with the pronoun.",
        problem: m[0],
        suggestions: [
          { kind: "replace", text: "have" },
          { kind: "insert", text: " to" },
          { kind: "remove", text: "" },
        ],
      });
    }
    for (const m of text.matchAll(/very unique/g)) {
      lints.push({ start: m.index, end: m.index + 4, kind: "Redundancy", message: "Redundant.", problem: "very", suggestions: [] });
    }
    for (const m of text.matchAll(/\bwrod\b/g)) {
      lints.push({ start: m.index, end: m.index + 4, kind: "Spelling", message: "Misspelled.", problem: m[0], suggestions: [] });
    }
    return lints;
  });

const noIgnore = { ignored: new Set<string>(), onIgnore: () => {} };

describe("prose extraction", () => {
  it("replaces skipped zones with a placeholder and maps offsets back around them", () => {
    const text = "Intro line.\n\nWe add $x + y$ to [@knuth84] and `code` so an test follows.\n";
    const [, block] = proseBlocks(text, 0, parse(text));
    expect(block.text).toBe("We add X to [X] and X so an test follows.");
    const at = block.text.indexOf("an test");
    const range = toDocument(block, at, at + 2)!;
    expect(text.slice(range.from, range.to)).toBe("an");
    expect(range.from).toBe(text.indexOf("an test"));
    const add = toDocument(block, 3, 6)!;
    expect(text.slice(add.from, add.to)).toBe("add");
  });

  it("rejects spans that reach into a skipped zone", () => {
    const text = "We add $x + y$ here.";
    const [block] = proseBlocks(text, 0, parse(text));
    const x = block.text.indexOf("X");
    expect(toDocument(block, x, x + 1)).toBeNull();
    expect(toDocument(block, x - 4, x + 1)).toBeNull();
    expect(toDocument(block, x + 1, x + 6)).toEqual({ from: text.indexOf(" here"), to: text.indexOf(" here") + 5 });
  });

  it("splits paragraphs, drops ones without prose and honours the slice offset", () => {
    const doc = "Before.\n\n```js\nlet an = test;\n```\n\n$$\na + b\n$$\n\nAfter an test, $y$.\n";
    const from = doc.indexOf("```js");
    const blocks = proseBlocks(doc.slice(from), from, parse(doc));
    expect(blocks.map((b) => b.text)).toEqual(["After an test, X."]);
    const range = toDocument(blocks[0], 6, 8)!;
    expect(doc.slice(range.from, range.to)).toBe("an");
  });

  it("widens visible ranges to whole paragraphs", () => {
    const doc = Text.of(["One", "two", "", "three", "four", "five", "", "six"]);
    const mid = doc.line(5).from;
    expect(proseRanges(doc, [{ from: mid, to: mid + 2 }])).toEqual([{ from: doc.line(4).from, to: doc.line(6).to }]);
    expect(proseRanges(doc, [{ from: 0, to: 1 }, { from: doc.line(2).from, to: doc.line(2).to }])).toEqual([
      { from: 0, to: doc.line(2).to },
    ]);
  });
});

describe("grammar diagnostics", () => {
  const text = "# An heading\n\nI has $x$ and an test with @key, very unique wrod.\n\n`an thing` here.";
  const doc = Text.of(text.split("\n"));

  it("maps lints to document ranges with severity, style and suggestion actions", async () => {
    const found = await findGrammar(doc, parse(text), whole(text), fakeLinter, noIgnore);
    expect(found.map((d) => [text.slice(d.from, d.to), d.severity])).toEqual([
      ["An", "warning"],
      ["an", "warning"],
      ["has", "warning"],
      ["very", "info"],
    ]);
    expect(found.every((d) => d.source === GRAMMAR_SOURCE && d.markClass === "pf-grammar")).toBe(true);
    expect(found[2].actions!.map((a) => a.name)).toEqual(["have", "Insert “ to”", "Remove", "Ignore"]);
    expect(found[3].actions!.map((a) => a.name)).toEqual(["Ignore"]);
  });

  it("applies suggestions as local text changes", async () => {
    const found = await findGrammar(doc, parse(text), whole(text), fakeLinter, noIgnore);
    const has = found[2];
    const apply = (name: string) => {
      let state = EditorState.create({ doc: text });
      const view = { dispatch: (spec: TransactionSpec) => (state = state.update(spec).state) } as unknown as EditorView;
      has.actions!.find((a) => a.name === name)!.apply(view, has.from, has.to);
      return state.doc.line(3).text;
    };
    expect(apply("have")).toBe("I have $x$ and an test with @key, very unique wrod.");
    expect(apply("Insert “ to”")).toBe("I has to $x$ and an test with @key, very unique wrod.");
    expect(apply("Remove")).toBe("I  $x$ and an test with @key, very unique wrod.");
  });

  it("ignores a lint by its kind, message and words", async () => {
    const keys: string[] = [];
    const found = await findGrammar(doc, parse(text), whole(text), fakeLinter, { ignored: new Set(), onIgnore: (k) => keys.push(k) });
    found[1].actions!.find((a) => a.name === "Ignore")!.apply({} as EditorView, found[1].from, found[1].to);
    expect(keys).toEqual(["Miscellaneous\nIncorrect indefinite article.\nan"]);
    const again = await findGrammar(doc, parse(text), whole(text), fakeLinter, { ignored: new Set(keys), onIgnore: () => {} });
    expect(again.map((d) => text.slice(d.from, d.to))).toEqual(["An", "has", "very"]);
  });

  it("drops lints whose words do not match the document", async () => {
    const shifted: LintTexts = async (texts) => (await fakeLinter(texts)).map((ls) => ls.map((l) => ({ ...l, start: l.start + 1, end: l.end + 1 })));
    expect(await findGrammar(doc, parse(text), whole(text), shifted, noIgnore)).toEqual([]);
    expect(lintKey({ start: 0, end: 1, kind: "K", message: "M", problem: "P", suggestions: [] })).toBe("K\nM\nP");
  });
});

describe("language gating", () => {
  it("checks English dialects only", () => {
    expect(dialectFor("en")).toBe("American");
    expect(dialectFor(undefined)).toBe("American");
    expect(dialectFor("en-US")).toBe("American");
    expect(dialectFor("en-GB")).toBe("British");
    expect(dialectFor("en_au")).toBe("Australian");
    expect(dialectFor("en-CA")).toBe("Canadian");
    expect(dialectFor("en-IN")).toBe("Indian");
    for (const other of ["es", "es-MX", "pt", "fr", "de", "it"]) expect(dialectFor(other)).toBeNull();
  });
});

describe("background diagnostics", () => {
  const doc = "Teh cat sat on on the mat.";
  const mark = (source: string, word: string, nth = 0): Diagnostic => {
    let from = -1;
    for (let i = 0; i <= nth; i++) from = doc.indexOf(word, from + 1);
    return { from, to: from + word.length, severity: "info", source, message: source };
  };
  const listed = (state: EditorState) => {
    const out: string[] = [];
    forEachDiagnostic(state, (d, from, to) => out.push(`${d.source}:${state.sliceDoc(from, to)}`));
    return out.sort();
  };
  const create = () =>
    EditorState.create({
      doc,
      extensions: [backgroundDiagnostics({ source: "spelling" }), backgroundDiagnostics({ source: "grammar", yieldTo: "spelling" })],
    });
  const publish = (state: EditorState, source: string, found: Diagnostic[]) => {
    const spec = publishSpec(state, source, found);
    return spec ? state.update(spec).state : state;
  };

  it("keeps spelling, grammar and compile diagnostics side by side", () => {
    let state = create();
    state = publish(state, "spelling", [mark("spelling", "Teh")]);
    state = publish(state, "grammar", [mark("grammar", "on on")]);
    state = state.update(setDiagnostics(state, [{ from: 0, to: doc.length, severity: "error", source: "pandoc", message: "x" }])).state;
    expect(listed(state)).toEqual(["grammar:on on", "pandoc:" + doc, "spelling:Teh"]);
    state = publish(state, "spelling", []);
    expect(listed(state)).toEqual(["grammar:on on", "pandoc:" + doc]);
    state = publish(state, "grammar", [mark("grammar", "mat")]);
    expect(listed(state)).toEqual(["grammar:mat", "pandoc:" + doc]);
  });

  it("hides grammar marks inside a spelling mark, whichever is published first", () => {
    let state = publish(create(), "grammar", [mark("grammar", "Teh"), mark("grammar", "on on")]);
    expect(listed(state)).toEqual(["grammar:Teh", "grammar:on on"]);
    state = publish(state, "spelling", [mark("spelling", "Teh")]);
    expect(listed(state)).toEqual(["grammar:on on", "spelling:Teh"]);
    state = publish(state, "grammar", [mark("grammar", "Teh"), mark("grammar", "on on")]);
    expect(listed(state)).toEqual(["grammar:on on", "spelling:Teh"]);
  });

  it("settles only sources that yield", () => {
    const registered = [{ source: "spelling" }, { source: "grammar", yieldTo: "spelling" }];
    const all = [mark("spelling", "on", 0), mark("grammar", "on", 0), mark("pandoc", "on", 0), mark("grammar", "on", 1)];
    expect(settle(all, registered).map((d) => `${d.source}@${d.from}`)).toEqual(["spelling@12", "pandoc@12", "grammar@15"]);
  });
});

describe("harper", () => {
  it("reports a known grammar error in the bundled binary, without spelling lints", { timeout: 60_000 }, async () => {
    const wasm = new URL("../../../node_modules/harper.js/dist/harper_wasm_slim_bg.wasm", import.meta.url).href;
    const lint = harperLinter(wasm);
    const text = "Some prose with $x$.\n\nThis is an test of a speling mistake.";
    const found = await findGrammar(Text.of(text.split("\n")), parse(text), whole(text), (texts) => lint("American", texts), noIgnore);
    expect(found.map((d) => [text.slice(d.from, d.to), d.message])).toEqual([["an", "Incorrect indefinite article."]]);
    expect(found[0].actions!.map((a) => a.name)).toEqual(["a", "Ignore"]);
  });
});
