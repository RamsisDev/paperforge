import { history, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  activeSpans,
  citationText,
  divFence,
  expandRegion,
  parseAttributes,
  parseCitation,
  plainCaption,
  rawFormat,
  referenceText,
  scanInline,
  touchesActive,
} from "./syntax";

const data = vi.hoisted(() => ({
  bib: "@article{shannon1948,\n  author = {Claude E. Shannon},\n  year = {1948}\n}\n",
  labels: {} as Record<string, { number: string; page: string }>,
  meta: { language: "en" },
  dir: "/p",
  figures: [],
  editorMode: "writing",
}));
vi.mock("@/store", () => ({
  store: { get: () => data, set: () => {} },
  useStore: { subscribe: () => () => {} },
  labelRef: (id: string) => data.labels[id],
}));

const {
  ChipWidget,
  editorMode,
  editorModeExtension,
  previewDecorations,
  previewReplace,
  registerBlockWidget,
  registerInlineWidget,
  writingMode,
} = await import("./index");

const kinds = (text: string) => scanInline(text).map((t) => `${t.kind}:${text.slice(t.from, t.to)}`);

describe("parseAttributes", () => {
  it("reads ids, classes and quoted or bare pairs", () => {
    expect(parseAttributes('#fig:x .wide width=80% alt="a \\"b\\" c"')).toEqual({
      id: "fig:x",
      classes: ["wide"],
      pairs: { width: "80%", alt: 'a "b" c' },
    });
    expect(parseAttributes("")).toEqual({ id: "", classes: [], pairs: {} });
  });
});

describe("parseCitation", () => {
  it("splits items and keeps locators", () => {
    expect(parseCitation("@knuth1984; @lamport1994, p. 3")).toEqual([
      { key: "knuth1984", locator: "" },
      { key: "lamport1994", locator: "p. 3" },
    ]);
    expect(parseCitation("see @a, ch. 2")).toEqual([{ key: "a", locator: "ch. 2" }]);
  });
  it("rejects brackets without citations", () => {
    expect(parseCitation("a link")).toBeNull();
    expect(parseCitation("@a; plain")).toBeNull();
    expect(parseCitation("mail me@x.org")).toBeNull();
  });
});

describe("scanInline", () => {
  it("finds citations, references and footnotes", () => {
    expect(kinds("Cite [@knuth1984; @l, p. 3] or @shannon1948 and @fig:x, ^[a [nested] note] [^1].")).toEqual([
      "cite:[@knuth1984; @l, p. 3]",
      "cite:@shannon1948",
      "ref:@fig:x",
      "footnote:^[a [nested] note]",
      "footnoteRef:[^1]",
    ]);
  });
  it("leaves e-mail addresses, links and footnote definitions alone", () => {
    expect(kinds("Write to a@b.org, see [text](http://x)")).toEqual([]);
    expect(kinds("[^1]: The note.")).toEqual([]);
  });
  it("finds inline and display math with its equation label", () => {
    const text = "Inline $H(X) \\ge 0$ and\n$$H(X) = -\\sum p$$ {#eq:entropy}\nafter";
    const tokens = scanInline(text, 10);
    expect(tokens.map((t) => t.kind)).toEqual(["math", "math"]);
    const [inline, display] = tokens;
    expect(inline).toMatchObject({ display: false, tex: "H(X) \\ge 0", from: 17, to: 29 });
    expect(display).toMatchObject({ display: true, tex: "H(X) = -\\sum p", label: "eq:entropy" });
    expect(text.slice(display.from - 10, display.to - 10)).toBe("$$H(X) = -\\sum p$$ {#eq:entropy}");
  });
  it("spans display math over lines and follows Pandoc's rules for $", () => {
    expect(kinds("$$\na\n+ b\n$$")).toEqual(["math:$$\na\n+ b\n$$"]);
    expect(kinds("costs $5 and $6")).toEqual([]);
    expect(kinds("$ x$ or \\$a$")).toEqual([]);
    expect(kinds("$a$1 then $b$")).toEqual(["math:$a$1 then $b$"]);
    expect(kinds("$a $ b$")).toEqual(["math:$a $ b$"]);
  });
  it("skips code spans but reads raw LaTeX spans", () => {
    expect(kinds("`[@a] $x$` and ``a ` b``")).toEqual([]);
    const [raw] = scanInline("x `\\LaTeX`{=latex} y");
    expect(raw).toMatchObject({ kind: "rawInline", format: "latex", from: 2, to: 18, code: { from: 3, to: 9 } });
  });
  it("finds attribute blocks", () => {
    const [attr] = scanInline(": Results. {#tbl:results}");
    expect(attr).toMatchObject({ kind: "attr", attrs: { id: "tbl:results" }, from: 11, to: 25 });
  });
});

describe("blocks", () => {
  it("reads div fences and raw formats", () => {
    expect(divFence("::: {.note #n}")).toEqual({ open: true, label: "note" });
    expect(divFence(":::: warning ::::")).toEqual({ open: true, label: "warning" });
    expect(divFence(":::")).toEqual({ open: false, label: "" });
    expect(divFence(":: no")).toBeNull();
    expect(rawFormat("{=latex}")).toBe("latex");
    expect(rawFormat("python")).toBeNull();
  });
});

describe("chip texts", () => {
  const entry = { key: "k", type: "book", title: "", author: "Donald E. Knuth and Leslie Lamport", year: "1984", line: 1 };
  it("names citations by author and year", () => {
    expect(citationText({ key: "k", locator: "p. 3" }, entry)).toBe("Knuth & Lamport 1984, p. 3");
    expect(citationText({ key: "nope", locator: "" }, undefined)).toBe("@nope");
  });
  it("numbers references, without repeating the kind already in the text", () => {
    expect(referenceText("fig:x", undefined, "en", "As in ")).toBe("Figure");
    expect(referenceText("fig:x", { number: "2", page: "3" }, "en", "As in ")).toBe("Figure 2");
    expect(referenceText("fig:x", { number: "2", page: "3" }, "en", "see Figure ")).toBe("2");
    expect(referenceText("tbl:x", undefined, "es", "la Tabla~")).toBe("?");
  });
  it("strips inline marks from captions", () => {
    expect(plainCaption("A *sample* figure with `{.wide}` and [a link](x).")).toBe("A sample figure with {.wide} and a link.");
  });
});

describe("reveal", () => {
  const doc = "line one\nline two\nline three";
  const line = (pos: number) => {
    const start = doc.lastIndexOf("\n", pos - 1) + 1;
    const end = doc.indexOf("\n", pos);
    return { from: start, to: end < 0 ? doc.length : end };
  };
  it("covers the lines of every cursor and selection, merged", () => {
    expect(activeSpans([{ from: 2, to: 2 }], line)).toEqual([{ from: 0, to: 8 }]);
    expect(activeSpans([{ from: 12, to: 12 }, { from: 3, to: 10 }], line)).toEqual([{ from: 0, to: 17 }]);
    expect(activeSpans([{ from: 0, to: 0 }, { from: 20, to: 20 }], line)).toEqual([
      { from: 0, to: 8 },
      { from: 18, to: 28 },
    ]);
  });
  it("reveals ranges that touch an active span, ends included", () => {
    const spans = [{ from: 9, to: 17 }];
    expect(touchesActive(0, 8, spans)).toBe(false);
    expect(touchesActive(17, 17, spans)).toBe(true);
    expect(touchesActive(0, 30, spans)).toBe(true);
    expect(touchesActive(18, 20, spans)).toBe(false);
  });
  it("grows a region to whole blocks", () => {
    const blocks = [
      { from: 0, to: 10 },
      { from: 12, to: 20 },
      { from: 22, to: 40 },
    ];
    const touching = (a: number, b: number) => blocks.filter((s) => s.from <= b && s.to >= a);
    expect(expandRegion(15, 15, touching)).toEqual({ from: 12, to: 20 });
    expect(expandRegion(11, 11, touching)).toEqual({ from: 11, to: 11 });
    expect(expandRegion(9, 13, touching)).toEqual({ from: 0, to: 20 });
  });
});

const SAMPLE = [
  "# Method {#sec:method}",
  "",
  "Inline math $H(X) \\ge 0$, **bold**, _em_ and [a link](http://x), see @fig:example and @shannon1948.",
  "",
  "$$H(X) = -\\sum_{i=1}^{n} p(x_i)$$ {#eq:entropy}",
  "",
  "![A sample figure.](figures/example.png){#fig:example width=90%}",
  "",
  "::: {.note}",
  "Text in a div.",
  ":::",
  "",
  "```{=latex}",
  "\\newpage",
  "```",
  "",
  "> A quote with a footnote^[The note.]",
].join("\n");

function create(doc: string, cursor: number, extra: Extension = []) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage }), writingMode(), extra],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  // The field was built against the tree available at creation; rebuild against the full one.
  return state.update({ effects: [] }).state;
}

function describeSet(state: EditorState, set: DecorationSet): string[] {
  const out: string[] = [];
  set.between(0, state.doc.length, (from, to, d) => {
    const widget = d.spec.widget?.constructor.name;
    const what = d.spec.class ? `line.${d.spec.class}` : d.spec.widget ? widget : d.spec.class ?? "hide";
    out.push(`${from}-${to} ${what} ${JSON.stringify(state.sliceDoc(from, Math.min(to, from + 18)))}`);
  });
  return out;
}

describe("Writing mode decorations", () => {
  it("renders the sample's constructs", () => {
    const state = create(SAMPLE, SAMPLE.length);
    const shown = describeSet(state, previewDecorations(state)!.shown).join("\n");
    expect(shown).toContain('0-2 hide "# "');
    expect(shown).toContain('MathWidget "$H(X) \\\\ge 0$"');
    expect(shown).toContain('ChipWidget "@fig:example"');
    expect(shown).toContain('ChipWidget "@shannon1948"');
    expect(shown).toContain('ChipWidget "{#sec:method}"');
    expect(shown).toContain('MathWidget "$$H(X) = -\\\\sum_{i="');
    expect(shown).toContain('FigureWidget "![A sample figure."');
    expect(shown).toContain('FenceLabelWidget "::: {.note}"');
    expect(shown).toContain('FenceLabelWidget "```{=latex}"');
    expect(shown).toContain("line.pf-lp-raw");
    expect(shown).toContain("line.pf-lp-heading pf-lp-h1");
    expect(shown).toContain('hide "**"');
    expect(shown).toContain('hide "](http://x)"');
    // The last line holds the cursor: its quote mark and footnote stay as typed.
    expect(shown).not.toContain('"> "');
    expect(shown).not.toContain("^[The note.]");
  });

  it("shows the source on the cursor's lines only", () => {
    const hidden = (state: EditorState) => describeSet(state, previewDecorations(state)!.shown).filter((d) => d.includes(" hide "));
    let state = create(SAMPLE, SAMPLE.length);
    expect(hidden(state).some((d) => d.startsWith("0-2 "))).toBe(true);
    state = state.update({ selection: EditorSelection.cursor(3) }).state;
    expect(hidden(state).some((d) => d.startsWith("0-2 "))).toBe(false);
    const all = describeSet(state, previewDecorations(state)!.all);
    expect(all.some((d) => d.startsWith("0-2 "))).toBe(true);
    // A selection reveals every line it touches, and a multi-line decoration touching it.
    const div = SAMPLE.indexOf("Text in a div");
    state = state.update({ selection: EditorSelection.range(SAMPLE.indexOf("$$H"), div) }).state;
    const shown = describeSet(state, previewDecorations(state)!.shown).join("\n");
    expect(shown).not.toContain("MathWidget \"$$H");
    expect(shown).not.toContain("FigureWidget");
    expect(shown).not.toContain('FenceLabelWidget "::: {.note}"');
    expect(shown).toContain('0-2 hide "# "');
  });

  it("rebuilds incrementally to the same decorations as a fresh build", () => {
    let state = create(SAMPLE, 0);
    const edits: [string, string][] = [
      ["Inline math", "Now inline math"],
      ["_em_", "_emphasis and $y$_"],
      [":::\n", ""],
      ["```{=latex}", "```"],
      ["```\n\n>", "```{=latex}\n\n>"],
      ["$$H(X)", "$$\nH(X)"],
      ["# Method", "Method"],
      ["\n\n![", "\n![" ],
    ];
    for (const [find, replace] of edits) {
      const at = state.doc.toString().indexOf(find);
      expect(at, find).toBeGreaterThanOrEqual(0);
      state = state.update({ changes: { from: at, to: at + find.length, insert: replace }, selection: { anchor: 0 } }).state;
      ensureSyntaxTree(state, state.doc.length, 5000);
      state = state.update({}).state;
      const fresh = create(state.doc.toString(), 0);
      expect(describeSet(state, previewDecorations(state)!.all), `after ${find} -> ${replace}`).toEqual(
        describeSet(fresh, previewDecorations(fresh)!.all),
      );
    }
  });

  it("switches modes without losing undo history or the selection", () => {
    let state = EditorState.create({
      doc: "# Title\n\nText $x$.",
      extensions: [markdown({ base: markdownLanguage }), history(), editorModeExtension()],
    });
    expect(previewDecorations(state)).not.toBeNull();
    state = state.update({ changes: { from: 9, insert: "More. " }, selection: { anchor: 15 } }).state;
    state = state.update({ effects: editorMode.reconfigure([]) }).state;
    expect(previewDecorations(state)).toBeNull();
    state = state.update({ effects: editorMode.reconfigure(writingMode()) }).state;
    expect(previewDecorations(state)).not.toBeNull();
    expect(state.selection.main.head).toBe(15);
    let undone = state;
    undo({ state, dispatch: (tr) => (undone = tr.state) });
    expect(undone.doc.toString()).toBe("# Title\n\nText $x$.");
  });

  it("lets registered providers replace blocks and inline widgets", () => {
    registerBlockWidget({ nodes: ["Table"], decorate: (b) => [previewReplace(b.from, b.to, new ChipWidget("grid", "table"))] });
    registerInlineWidget("cite", (token) => (token.bracketed ? new ChipWidget("custom", "cite") : null));
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n\nSee [@x] and @y.\n\nEnd";
    const state = create(doc, doc.length);
    const shown = describeSet(state, previewDecorations(state)!.shown);
    expect(shown[0]).toMatch(/^0-29 ChipWidget/);
    const cites = shown.filter((d) => d.includes('"[@x]"') || d.includes('"@y"'));
    expect(cites).toHaveLength(2);
  });
});
