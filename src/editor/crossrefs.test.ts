import type { Completion } from "@codemirror/autocomplete";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  parts: [
    { file: "a.md", content: "# A {#sec:intro}\n\n![Cap](f.png){#fig:example width=50%}\n" },
    { file: "b.md", content: "$$x$$ {#eq:entropy}\n\n: Results {#tbl:results}\n" },
  ],
  labels: {} as Record<string, { number: string; page: string }>,
  meta: { language: "es" },
}));
vi.mock("@/store", () => ({ store: { get: () => state } }));

const { labelOptions, pickerOptions } = await import("./crossrefs");

/** Applies a picker option at the end of `doc`, as if `/ref` had just been typed there. */
function pick(option: Completion, doc: string): string {
  let current = EditorState.create({ doc: `${doc}/ref` });
  const view = {
    get state() {
      return current;
    },
    dispatch: (spec: TransactionSpec) => (current = current.update(spec).state),
  } as unknown as EditorView;
  const to = current.doc.length;
  (option.apply as (v: EditorView, c: Completion, from: number, to: number) => void)(view, option, to - 4, to);
  return current.doc.toString();
}

describe("label completions", () => {
  it("name the kind before the first compile", () => {
    state.labels = {};
    expect(labelOptions().map((o) => `${o.label} ${o.detail}`)).toEqual([
      "@fig:example Figure",
      "@tbl:results Table",
      "@eq:entropy Equation",
      "@sec:intro Section",
    ]);
  });

  it("add the number and page of the last compile", () => {
    state.labels = { "fig:example": { number: "2", page: "3" }, "sec:intro": { number: "1", page: "1" } };
    expect(labelOptions().map((o) => o.detail)).toEqual(["Figure 2 · p. 3", "Table", "Equation", "Section 1 · p. 1"]);
  });
});

describe("reference picker", () => {
  it("lists what it inserts in the document language", () => {
    state.labels = { "tbl:results": { number: "2.1", page: "5" } };
    const options = pickerOptions("es");
    expect(options.map((o) => `${o.label} | ${o.displayLabel} | ${o.detail}`)).toEqual([
      "/ref fig:example | Figura @fig:example | Figure",
      "/ref tbl:results | Tabla @tbl:results | Table 2.1 · p. 5",
      "/ref eq:entropy | Ecuación @eq:entropy | Equation",
      "/ref sec:intro | Sección @sec:intro | Section",
    ]);
  });

  it("replaces /ref with the name and the reference, once", () => {
    const [figure] = pickerOptions("en");
    expect(pick(figure, "As shown in ")).toBe("As shown in Figure @fig:example");
    expect(pick(figure, "As shown in Figure ")).toBe("As shown in Figure @fig:example");
    expect(pick(pickerOptions("pt")[1], "Line one\nVeja a ")).toBe("Line one\nVeja a Tabela @tbl:results");
  });
});
