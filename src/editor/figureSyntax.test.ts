import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  figureAttribute,
  figureFileName,
  figureId,
  hasClass,
  parseFigure,
  setAttribute,
  setCaption,
  setClass,
  setId,
  setWidth,
  uniqueFigureLabel,
  widthPercent,
  type Figure,
  type TextChange,
} from "./figureSyntax";

const SAMPLE =
  "![A sample figure. Add `{.wide}` to span both columns.](figures/example.png){#fig:example width=90%}";

function fig(line: string, base = 0): Figure {
  const parsed = parseFigure(line, base);
  if (!parsed) throw new Error(`not a figure: ${line}`);
  return parsed;
}

/** Applies the changes through CodeMirror, as the inspector does. */
function apply(line: string, edit: (f: Figure) => TextChange[]): string {
  const state = EditorState.create({ doc: line });
  return state.update({ changes: edit(fig(line)) }).state.doc.toString();
}

describe("parseFigure", () => {
  it("reads caption, source and attributes of the sample figure", () => {
    const f = fig(SAMPLE);
    expect(f.caption.text).toBe("A sample figure. Add `{.wide}` to span both columns.");
    expect(f.src.text).toBe("figures/example.png");
    expect(figureId(f)).toBe("fig:example");
    expect(figureAttribute(f, "width")).toBe("90%");
    expect(widthPercent(f)).toBe(90);
    expect(SAMPLE.slice(f.block!.from, f.block!.to)).toBe("{#fig:example width=90%}");
  });

  it("handles nested brackets, titles, classes and quoted values", () => {
    const line = '![See [@knuth] and `a]b` \\]](<figures/my plot.png> "Title (x)"){#fig:a .wide alt="A \\"quoted\\" {alt}" data=\'x y\' height=3cm}';
    const f = fig(line, 100);
    expect(f.caption.text).toBe("See [@knuth] and `a]b` \\]");
    expect(f.src.text).toBe("figures/my plot.png");
    expect(f.attrs.map((a) => a.kind)).toEqual(["id", "class", "pair", "pair", "pair"]);
    expect(hasClass(f, "wide")).toBe(true);
    expect(figureAttribute(f, "alt")).toBe('A "quoted" {alt}');
    expect(figureAttribute(f, "data")).toBe("x y");
    expect(figureAttribute(f, "height")).toBe("3cm");
    expect(widthPercent(f)).toBeNull();
    expect(line.slice(f.caption.from - 100, f.caption.to - 100)).toBe(f.caption.text);
  });

  it("accepts a figure without attributes and leading spaces", () => {
    const f = fig("  ![Cap](a.png)  ");
    expect(f.block).toBeNull();
    expect(f.end).toBe(15);
  });

  it("rejects lines that are not a lone image", () => {
    for (const line of ["Text ![a](b.png)", "![a](b.png) more", "![a(b.png)", "![a](b.png){#x", "[a](b.png)", "    ![a](b.png)"]) {
      expect(parseFigure(line), line).toBeNull();
    }
  });
});

describe("figure edits", () => {
  it("changes only the width value", () => {
    const f = fig(SAMPLE);
    const [change] = setWidth(f, 50);
    expect(SAMPLE.slice(change.from, change.to)).toBe("90%");
    expect(apply(SAMPLE, (x) => setWidth(x, 50))).toBe(SAMPLE.replace("width=90%", "width=50%"));
    expect(setWidth(f, 90)).toEqual([]);
  });

  it("adds and removes width, keeping other attributes and their order", () => {
    const line = "![C](a.png){#fig:a .x key=v}";
    expect(apply(line, (f) => setWidth(f, 40))).toBe("![C](a.png){#fig:a .x key=v width=40%}");
    expect(apply("![C](a.png){#fig:a width=40% .x}", (f) => setWidth(f, null))).toBe("![C](a.png){#fig:a .x}");
    expect(apply("![C](a.png)", (f) => setWidth(f, 70))).toBe("![C](a.png){width=70%}");
  });

  it("toggles .wide as an insertion or a deletion", () => {
    const on = setClass(fig(SAMPLE), "wide", true);
    expect(on).toEqual([{ from: SAMPLE.length - 1, to: SAMPLE.length - 1, insert: " .wide" }]);
    const wide = apply(SAMPLE, (f) => setClass(f, "wide", true));
    expect(wide).toBe("![A sample figure. Add `{.wide}` to span both columns.](figures/example.png){#fig:example width=90% .wide}");
    expect(setClass(fig(wide), "wide", true)).toEqual([]);
    expect(apply(wide, (f) => setClass(f, "wide", false))).toBe(SAMPLE);
    expect(apply("![C](a.png){.wide #fig:a}", (f) => setClass(f, "wide", false))).toBe("![C](a.png){#fig:a}");
    expect(apply("![C](a.png){.wide}", (f) => setClass(f, "wide", false))).toBe("![C](a.png)");
  });

  it("replaces only the caption span", () => {
    const [change] = setCaption(fig(SAMPLE), "New caption with $x$");
    expect(change.from).toBe(2);
    expect(SAMPLE.slice(change.to)).toMatch(/^\]\(figures\/example\.png\)/);
    expect(apply(SAMPLE, (f) => setCaption(f, "New"))).toBe("![New](figures/example.png){#fig:example width=90%}");
  });

  it("renames, adds and removes the label", () => {
    const [change] = setId(fig(SAMPLE), "fig:plot");
    expect(SAMPLE.slice(change.from, change.to)).toBe("fig:example");
    expect(apply("![C](a.png){width=5cm}", (f) => setId(f, "fig:a"))).toBe("![C](a.png){#fig:a width=5cm}");
    expect(apply("![C](a.png)", (f) => setId(f, "fig:a"))).toBe("![C](a.png){#fig:a}");
    expect(apply(SAMPLE, (f) => setId(f, ""))).toBe(SAMPLE.replace("#fig:example ", ""));
  });

  it("quotes alt text only when it needs quotes", () => {
    const line = "![C](a.png){#fig:a}";
    expect(apply(line, (f) => setAttribute(f, "alt", "Bar chart of results"))).toBe('![C](a.png){#fig:a alt="Bar chart of results"}');
    expect(apply(line, (f) => setAttribute(f, "alt", "chart"))).toBe("![C](a.png){#fig:a alt=chart}");
    const quoted = '![C](a.png){#fig:a alt="Say \\"hi\\"" width=50%}';
    const [change] = setAttribute(fig(quoted), "alt", 'He said "no"');
    expect(quoted.slice(change.from, change.to)).toBe('"Say \\"hi\\""');
    const edited = apply(quoted, (f) => setAttribute(f, "alt", 'He said "no"'));
    expect(figureAttribute(fig(edited), "alt")).toBe('He said "no"');
    expect(apply(quoted, (f) => setAttribute(f, "alt", null))).toBe("![C](a.png){#fig:a width=50%}");
  });
});

describe("pasted figures", () => {
  it("derives unique labels from file names", () => {
    expect(uniqueFigureLabel("plot", [])).toBe("fig:plot");
    expect(uniqueFigureLabel("Plot", ["fig:plot", "fig:plot-2"])).toBe("fig:plot-3");
    expect(uniqueFigureLabel("--", [])).toBe("fig:figure");
  });

  it("names clipboard files with an allowed extension or rejects them", () => {
    expect(figureFileName("shot.PNG", "image/png")).toBe("shot.PNG");
    expect(figureFileName("image", "image/png")).toBe("image.png");
    expect(figureFileName("", "image/jpeg")).toBe("figure.jpg");
    expect(figureFileName("paper.pdf", "")).toBe("paper.pdf");
    expect(figureFileName("anim.gif", "image/gif")).toBeNull();
    expect(figureFileName("logo.svg", "image/svg+xml")).toBeNull();
  });
});
