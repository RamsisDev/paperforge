import { Text } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/store", () => ({ store: { get: () => ({ meta: null }) } }));
vi.mock("@/session", () => ({ updateMeta: () => {} }));

const { toggleCharacterStyle, toggleParagraphStyle } = await import("./styles");
const { styleDefinition, styleProblem } = await import("@/lib/styles");

type Toggle = typeof toggleCharacterStyle;

/** `doc` marks the selection with `«` and `»` (or a single `|` for a cursor). */
function parse(doc: string): { text: string; from: number; to: number } {
  if (doc.includes("|")) {
    const at = doc.indexOf("|");
    return { text: doc.replace("|", ""), from: at, to: at };
  }
  const from = doc.indexOf("«");
  const to = doc.indexOf("»") - 1;
  return { text: doc.replace("«", "").replace("»", ""), from, to };
}

function show(text: string, anchor: number, head: number): string {
  if (anchor === head) return `${text.slice(0, anchor)}|${text.slice(anchor)}`;
  return `${text.slice(0, anchor)}«${text.slice(anchor, head)}»${text.slice(head)}`;
}

function run(toggle: Toggle, doc: string, name: string) {
  const { text, from, to } = parse(doc);
  const edit = toggle(Text.of(text.split("\n")), from, to, name);
  let out = text;
  for (const c of [...edit.changes].reverse()) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return { doc: show(out, edit.selection.anchor, edit.selection.head), changes: edit.changes };
}

const apply = (toggle: Toggle, doc: string, name: string) => run(toggle, doc, name).doc;

describe("character styles", () => {
  it("wraps the selection with two insertions and keeps the text selected", () => {
    const { doc, changes } = run(toggleCharacterStyle, "Some «key words» here", "smallcaps");
    expect(doc).toBe("Some [«key words»]{.smallcaps} here");
    expect(changes).toEqual([
      { from: 5, to: 5, insert: "[" },
      { from: 14, to: 14, insert: "]{.smallcaps}" },
    ]);
  });

  it("toggles back to the original text and selection", () => {
    for (const start of ["Some «key words» here", "«whole»", "a «b» c [d]{.smallcaps}"]) {
      const once = apply(toggleCharacterStyle, start, "smallcaps");
      expect(apply(toggleCharacterStyle, once, "smallcaps")).toBe(start);
    }
  });

  it("removes the style when the whole span or a part of its text is selected", () => {
    const { doc, changes } = run(toggleCharacterStyle, "x «[key]{.smallcaps}» y", "smallcaps");
    expect(doc).toBe("x «key» y");
    expect(changes).toEqual([
      { from: 2, to: 3, insert: "" },
      { from: 6, to: 19, insert: "" },
    ]);
    expect(apply(toggleCharacterStyle, "x [ke|y]{.smallcaps} y", "smallcaps")).toBe("x ke|y y");
  });

  it("adds or removes only the class when the span has other attributes", () => {
    expect(apply(toggleCharacterStyle, "[«key»]{.mark}", "smallcaps")).toBe("[«key»]{.mark .smallcaps}");
    expect(apply(toggleCharacterStyle, "[«key»]{.mark .smallcaps}", "smallcaps")).toBe("[«key»]{.mark}");
    expect(apply(toggleCharacterStyle, "[«key»]{.smallcaps #id}", "smallcaps")).toBe("[«key»]{#id}");
  });

  it("nests a style inside another span's text and leaves links alone", () => {
    expect(apply(toggleCharacterStyle, "[a «b» c]{.mark}", "keyword")).toBe("[a [«b»]{.keyword} c]{.mark}");
    expect(apply(toggleCharacterStyle, "[«a»](https://x.org)", "keyword")).toBe("[[«a»]{.keyword}](https://x.org)");
  });

  it("inserts a placeholder at a bare cursor", () => {
    expect(apply(toggleCharacterStyle, "a | b", "keyword")).toBe("a [«text»]{.keyword} b");
  });
});

describe("paragraph styles", () => {
  const doc = "# Title\n\nFirst line\nsecond «line».\n\nNext paragraph.";

  it("wraps the whole paragraph around the selection with two insertions", () => {
    const { doc: out, changes } = run(toggleParagraphStyle, doc, "note");
    expect(out).toBe("# Title\n\n::: {.note}\nFirst line\nsecond «line».\n:::\n\nNext paragraph.");
    expect(changes).toEqual([
      { from: 9, to: 9, insert: "::: {.note}\n" },
      { from: 32, to: 32, insert: "\n:::" },
    ]);
  });

  it("toggles back to the original text and selection", () => {
    const starts = [
      doc,
      "«Only»",
      "A\n\nB «one»\n\nC «two»\n\nD",
      "::: {.callout}\nInside |a callout.\n:::",
      "::: {.note}\nOther note.\n:::\n\nMine|.",
    ];
    for (const start of starts) {
      const once = apply(toggleParagraphStyle, start, "note");
      expect(once).not.toBe(start);
      expect(apply(toggleParagraphStyle, once, "note")).toBe(start);
    }
  });

  it("covers every paragraph a selection touches", () => {
    expect(apply(toggleParagraphStyle, "A\n\nB «one\n\nC» two\n\nD", "note")).toBe(
      "A\n\n::: {.note}\nB «one\n\nC» two\n:::\n\nD",
    );
  });

  it("removes the fences of the enclosing styled div, even from a nested paragraph", () => {
    const styled = "Intro.\n\n::: {.note}\nOne.\n\n::: {.callout}\nNes|ted.\n:::\n:::\n\nAfter.";
    expect(apply(toggleParagraphStyle, styled, "note")).toBe("Intro.\n\nOne.\n\n::: {.callout}\nNes|ted.\n:::\n\nAfter.");
    expect(apply(toggleParagraphStyle, "::: note\nBare |class.\n:::\n", "note")).toBe("Bare |class.\n");
  });

  it("removes only the class from a fence with other attributes", () => {
    const { doc: out, changes } = run(toggleParagraphStyle, "::: {#box .note .wide}\nText|.\n:::", "note");
    expect(out).toBe("::: {#box .wide}\nText|.\n:::");
    expect(changes).toEqual([{ from: 9, to: 15, insert: "" }]);
  });

  it("wraps a nested paragraph inside another div", () => {
    expect(apply(toggleParagraphStyle, "::: {.callout}\nInside |a callout.\n:::", "note")).toBe(
      "::: {.callout}\n::: {.note}\nInside |a callout.\n:::\n:::",
    );
  });

  it("inserts a placeholder paragraph on a blank line", () => {
    expect(apply(toggleParagraphStyle, "A\n\n|\n\nB", "note")).toBe("A\n\n::: {.note}\n«text»\n:::\n\nB");
  });
});

describe("style definitions", () => {
  it("match what the compiler generates", () => {
    expect(styleDefinition({ name: "note", kind: "paragraph", latex: "\\begin{quote}\n#1\n\\end{quote}" })).toBe(
      "\\newenvironment{pf-note}{\\begin{quote}}{\\end{quote}}",
    );
    expect(styleDefinition({ name: "key-word2", kind: "character", latex: "\\textbf{#1}" })).toBe(
      "\\newcommand{\\pfstylekeyZwordC}[1]{\\textbf{#1}}",
    );
  });

  it("report the problems the compiler rejects", () => {
    const ok = { name: "note", kind: "paragraph" as const, latex: "#1" };
    expect(styleProblem(ok, [ok])).toBeNull();
    expect(styleProblem({ ...ok, name: "Bad name" }, [])).toMatch(/lowercase/);
    expect(styleProblem({ ...ok, latex: "\\x" }, [])).toMatch(/#1/);
    expect(styleProblem({ ...ok, latex: "#1#1" }, [])).toMatch(/once/);
    expect(styleProblem(ok, [ok, { ...ok }])).toMatch(/Another/);
  });
});
