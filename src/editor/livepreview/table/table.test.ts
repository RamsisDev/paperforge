import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import {
  captionId,
  formatCaption,
  formatTable,
  formatTableBlock,
  insertColumn,
  insertRow,
  lineChanges,
  parseCaption,
  parseTableBlock,
  removeColumn,
  removeRow,
  setAlign,
  setCell,
  splitRow,
  tableLabel,
  toggleHeader,
  uniqueTableLabel,
  withCaptionId,
  type PipeTable,
} from "./pipe";
import { convertSimpleTable } from "./simple";

vi.mock("@/store", () => ({
  store: { get: () => ({ meta: { language: "en" }, labels: {}, parts: [], bib: "", figures: [], dir: "/p", editorMode: "writing" }) },
  useStore: { subscribe: () => () => {} },
  labelRef: (id: string) => (id === "tbl:results" ? { number: "2.1", page: "6" } : undefined),
}));

const { previewDecorations, writingMode } = await import("../index");
const { tableSnippet } = await import("./insert");

const ALIGNED = [
  "| Model    |  Accuracy | Latency (ms) |",
  "|:---------|----------:|-------------:|",
  "| Baseline |     0.812 |           14 |",
  "| Ours     | **0.874** |           11 |",
].join("\n");

function apply(text: string, changes: { from: number; to: number; insert: string }[]): string {
  let out = text;
  for (const c of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

function table(text: string): PipeTable {
  return parseTableBlock(text)!.table;
}

describe("splitRow", () => {
  it("reads cells with or without outer pipes", () => {
    expect(splitRow("| a | b |")).toEqual(["a", "b"]);
    expect(splitRow("a | b")).toEqual(["a", "b"]);
    expect(splitRow("| a | b")).toEqual(["a", "b"]);
    expect(splitRow("a | b |")).toEqual(["a", "b"]);
    expect(splitRow("| a | |")).toEqual(["a", ""]);
    expect(splitRow("no pipe")).toBeNull();
  });
  it("keeps escaped pipes and pipes in code spans inside the cell", () => {
    expect(splitRow("| a \\| b | `x | y` | ``a ` | b`` |")).toEqual(["a | b", "`x | y`", "``a ` | b``"]);
    expect(splitRow("| `open | b |")).toEqual(["`open", "b"]);
  });
});

describe("parseTableBlock", () => {
  it("reads the alignment row", () => {
    const t = table("| a | b | c | d |\n|---|:--|:-:|--:|\n| 1 | 2 | 3 | 4 |");
    expect(t.align).toEqual(["", "left", "center", "right"]);
    expect(t.header).toEqual(["a", "b", "c", "d"]);
    expect(t.rows).toEqual([["1", "2", "3", "4"]]);
  });
  it("pads short rows and rejects what it cannot keep intact", () => {
    expect(table("a | b\n--|--\n1 |").rows).toEqual([["1", ""]]);
    expect(parseTableBlock("| a | b |\n|---|---|\n| 1 | 2 | 3 |")).toBeNull();
    expect(parseTableBlock("| a | b |\n|---|\n| 1 | 2 |")).toBeNull();
    expect(parseTableBlock("| a | b |\n|---|---|\nplain text")).toBeNull();
  });
  it("splits off a caption written right under the table", () => {
    const text = "| a |\n|---|\n| 1 |\n: Results. {#tbl:x .wide}";
    const block = parseTableBlock(text)!;
    expect(block.table.rows).toEqual([["1"]]);
    expect(text.slice(block.captionAt)).toBe(": Results. {#tbl:x .wide}");
    expect(block.caption).toMatchObject({ text: "Results.", attrs: "#tbl:x .wide" });
    expect(captionId(block.caption!)).toBe("tbl:x");
  });
});

describe("captions", () => {
  it("formats back to the same text", () => {
    for (const text of [": Results on the test set. {#tbl:results}", "Table:  Two  spaces.", ": A caption\non two lines {#tbl:a}  ", ": Only text"]) {
      expect(formatCaption(parseCaption(text)!)).toBe(text);
    }
  });
  it("sets, changes and removes the label, keeping other attributes", () => {
    const c = parseCaption(": Text. {#tbl:a .wide}")!;
    expect(formatCaption(withCaptionId(c, "tbl:b"))).toBe(": Text. {#tbl:b .wide}");
    expect(formatCaption(withCaptionId(c, ""))).toBe(": Text. {.wide}");
    expect(formatCaption(withCaptionId(parseCaption(": Text. {#tbl:a}")!, ""))).toBe(": Text.");
    expect(formatCaption(withCaptionId(parseCaption(": Text.")!, "tbl:new"))).toBe(": Text. {#tbl:new}");
  });
  it("makes labels with the tbl: prefix, unique", () => {
    expect(tableLabel("My results")).toBe("tbl:My-results");
    expect(tableLabel("#tbl:x")).toBe("tbl:x");
    expect(tableLabel("  ")).toBe("");
    expect(uniqueTableLabel(["tbl:table", "tbl:table-2"])).toBe("tbl:table-3");
  });
});

describe("formatTable", () => {
  it("round-trips an aligned table byte for byte", () => {
    expect(formatTable(table(ALIGNED))).toBe(ALIGNED);
    const block = `${ALIGNED}\n: Caption {#tbl:x}`;
    expect(formatTableBlock(table(block), parseTableBlock(block)!, block)).toBe(block);
  });
  it("aligns the sample's ragged table and escapes pipes", () => {
    const ragged = "| Model    | Accuracy | Latency (ms) |\n|:---------|---------:|-------------:|\n| Baseline |    0.812 |           14 |\n| Ours     |**0.874** |           11 |";
    expect(formatTable(table(ragged))).toBe(ALIGNED);
    expect(formatTable(setCell(table("| a |\n|---|\n| 1 |"), 0, 0, "x | y"))).toBe("| a      |\n|--------|\n| x \\| y |");
    const code = "| `a | b` |\n|---------|\n| 1       |";
    expect(formatTable(table(code))).toBe(code);
  });
});

describe("lineChanges", () => {
  it("replaces only the edited row when the widths stay", () => {
    const after = formatTable(setCell(table(ALIGNED), 0, 1, "0.900"));
    const changes = lineChanges(ALIGNED, after);
    expect(changes).toHaveLength(1);
    expect(ALIGNED.slice(changes[0].from, changes[0].to)).toBe("| Baseline |     0.812 |           14 |");
    expect(changes[0].insert).toBe("| Baseline |     0.900 |           14 |");
    expect(apply(ALIGNED, changes)).toBe(after);
  });
  it("rewrites every line when a column gets wider", () => {
    const after = formatTable(setCell(table(ALIGNED), 1, 0, "Ours (large)"));
    const changes = lineChanges(ALIGNED, after);
    expect(changes).toHaveLength(4);
    expect(apply(ALIGNED, changes)).toBe(after);
  });
  it("inserts and deletes lines at the start, middle and end", () => {
    const cases: [string, string][] = [
      ["a\nb", "a\nb\nc"],
      ["a\nb\nc", "a\nb"],
      ["a\nb", "x\na\nb"],
      ["a\nb\nc", "a\nc"],
      ["a\nc", "a\nb\nc"],
      ["a", "b\nc"],
      ["", "\n\n: Caption"],
    ];
    for (const [before, after] of cases) expect(apply(before, lineChanges(before, after)), `${before} -> ${after}`).toBe(after);
    expect(lineChanges("a\nb", "a\nb\nc")).toEqual([{ from: 3, to: 3, insert: "\nc" }]);
    expect(lineChanges("same", "same")).toEqual([]);
  });
});

describe("table edits", () => {
  const t = table("| a | b |\n|---|--:|\n| 1 | 2 |\n| 3 | 4 |");
  it("adds and removes rows", () => {
    expect(insertRow(t, 1).rows).toEqual([["1", "2"], ["", ""], ["3", "4"]]);
    expect(insertRow(t, 99).rows.at(-1)).toEqual(["", ""]);
    expect(removeRow(t, 0).rows).toEqual([["3", "4"]]);
    expect(removeRow(removeRow(t, 0), 0)).toEqual(removeRow(t, 0));
    expect(formatTable(insertRow(t, 2))).toBe("| a   |   b |\n|-----|----:|\n| 1   |   2 |\n| 3   |   4 |\n|     |     |");
  });
  it("adds and removes columns with their alignment", () => {
    const wider = insertColumn(t, 1);
    expect(wider.header).toEqual(["a", "", "b"]);
    expect(wider.align).toEqual(["", "", "right"]);
    expect(wider.rows[0]).toEqual(["1", "", "2"]);
    expect(removeColumn(t, 0)).toEqual({ header: ["b"], align: ["right"], rows: [["2"], ["4"]] });
    expect(removeColumn(removeColumn(t, 0), 0).header).toEqual(["b"]);
  });
  it("changes a column's alignment in the delimiter row and the padding", () => {
    expect(formatTable(setAlign(t, 0, "center")).split("\n").slice(0, 3)).toEqual(["|  a  |   b |", "|:---:|----:|", "|  1  |   2 |"]);
    expect(formatTable(setAlign(t, 1, "")).split("\n")[1]).toBe("|-----|-----|");
    expect(formatTable(setAlign(t, 1, "left")).split("\n")[1]).toBe("|-----|:----|");
  });
  it("moves the header row into the body and back", () => {
    const headless = toggleHeader(t);
    expect(headless.header).toEqual(["", ""]);
    expect(headless.rows[0]).toEqual(["a", "b"]);
    expect(toggleHeader(headless)).toEqual(t);
  });
});

describe("convertSimpleTable", () => {
  const SIMPLE = [
    "",
    "  Right     Left     Center     Default",
    "-------     ------ ----------   -------",
    "     12     12        12            12",
    "    123     123       123          123",
    "      1     1          1             1",
    "",
  ];
  it("converts Pandoc's example with its alignments", () => {
    const c = convertSimpleTable(SIMPLE, 2)!;
    expect(c).toMatchObject({ first: 1, last: 5 });
    expect(c.text).toBe(
      [
        "| Right | Left | Center | Default |",
        "|------:|:-----|:------:|---------|",
        "|    12 | 12   |   12   | 12      |",
        "|   123 | 123  |  123   | 123     |",
        "|     1 | 1    |   1    | 1       |",
      ].join("\n"),
    );
  });
  it("drops a closing dashed line", () => {
    const lines = ["a     b", "---   ---", "1     2", "---   ---"];
    expect(convertSimpleTable(lines, 1)).toMatchObject({ first: 0, last: 3, text: "| a   | b   |\n|:----|:----|\n| 1   | 2   |" });
  });
  it("leaves tables it cannot convert losslessly", () => {
    expect(convertSimpleTable(["a     b", "---   ---", "1   word   2"], 1)).toBeNull();
    expect(convertSimpleTable(["a     b", "---   ---", `1     ${"long ".repeat(15)}`], 1)).toBeNull();
    expect(convertSimpleTable(["a     b", "---   ---", "1\\    2"], 1)).toBeNull();
    expect(convertSimpleTable(["text", "a     b", "---   ---", "1     2"], 2)).toBeNull();
    expect(convertSimpleTable(["a", "---", "1"], 1)).toBeNull();
  });
});

describe("tableSnippet", () => {
  it("inserts an aligned table with caption and label fields", () => {
    expect(tableSnippet(2, 1, "tbl:table-2")).toBe(
      "| Column 1 | Column 2 |\n|----------|----------|\n|          |          |\n\n: ${Caption} {#tbl:${table-2}}",
    );
  });
});

function create(doc: string, cursor = doc.length): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage }), writingMode()],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state.update({ effects: [] }).state;
}

function widgets(state: EditorState): string[] {
  const out: string[] = [];
  previewDecorations(state)!.shown.between(0, state.doc.length, (from, to, d) => {
    const name = d.spec.widget?.constructor.name;
    if (name && /Table|Caption|Convert/.test(name)) out.push(`${name} ${JSON.stringify(state.sliceDoc(from, to).split("\n")[0])}`);
  });
  return out;
}

describe("Writing mode tables", () => {
  const SAMPLE = `## Results\n\n${ALIGNED}\n\n: Results on the test set. {#tbl:results}\n\nAfter.`;

  it("renders the table as a grid and its caption as fields", () => {
    expect(widgets(create(SAMPLE))).toEqual([`TableWidget "${ALIGNED.split("\n")[0]}"`, 'CaptionWidget ": Results on the test set. {#tbl:results}"']);
  });
  it("finds a caption before the table or on its own lines", () => {
    expect(widgets(create(`: Before. {#tbl:a}\n\n| a |\n|---|\n| 1 |\n\nEnd`))).toEqual([
      'CaptionWidget ": Before. {#tbl:a}"',
      'TableWidget "| a |"',
    ]);
    expect(widgets(create(`| a |\n|---|\n| 1 |\n: Inside. {#tbl:a}\n\nEnd`))).toEqual(['TableWidget "| a |"']);
    expect(widgets(create(`: Not a caption.\n\nEnd`))).toEqual([]);
  });
  it("shows the source while the cursor is on the table", () => {
    expect(widgets(create(SAMPLE, SAMPLE.indexOf("Baseline")))).toEqual(['CaptionWidget ": Results on the test set. {#tbl:results}"']);
  });
  it("leaves grid tables as source and offers to convert simple tables", () => {
    const grid = "+---+---+\n| a | b |\n+===+===+\n| 1 | 2 |\n+---+---+\n\nEnd";
    expect(widgets(create(grid))).toEqual([]);
    const simple = "Intro.\n\n  a     b\n---   ---\n  1     2\n\nEnd";
    expect(widgets(create(simple))).toEqual(['ConvertWidget ""']);
  });
});
