import { describe, expect, it } from "vitest";
import { refDetail, refKind, refName, referenceText } from "./refnames";

describe("refName", () => {
  it("names each kind in every supported language", () => {
    const names = ["en", "es", "pt", "fr", "de", "it"].map((lang) =>
      (["fig", "tbl", "eq", "sec"] as const).map((kind) => refName(kind, lang)).join(" "),
    );
    expect(names).toEqual([
      "Figure Table Equation Section",
      "Figura Tabla Ecuación Sección",
      "Figura Tabela Equação Seção",
      "Figure Tableau Équation Section",
      "Abbildung Tabelle Gleichung Abschnitt",
      "Figura Tabella Equazione Sezione",
    ]);
  });

  it("uses the base language and falls back to English", () => {
    expect(refName("tbl", "pt-BR")).toBe("Tabela");
    expect(refName("fig", "ES_mx")).toBe("Figura");
    expect(refName("eq", "ja")).toBe("Equation");
    expect(refName("sec", undefined)).toBe("Section");
  });

  it("knows only the four reference prefixes", () => {
    expect(["fig:a", "tbl:b", "eq:c", "sec:d", "lst:e", "figure"].map(refKind)).toEqual([
      "fig",
      "tbl",
      "eq",
      "sec",
      null,
      null,
    ]);
  });
});

describe("referenceText", () => {
  it("inserts the localized name before the reference", () => {
    expect(referenceText("fig:x", "en", "As shown in ")).toBe("Figure @fig:x");
    expect(referenceText("fig:x", "es", "Como muestra la ")).toBe("Figura @fig:x");
    expect(referenceText("tbl:r", "de", "")).toBe("Tabelle @tbl:r");
    expect(referenceText("eq:h", "fr", "(")).toBe("Équation @eq:h");
  });

  it("does not repeat a name the text already has", () => {
    expect(referenceText("fig:x", "en", "As shown in Figure ")).toBe("@fig:x");
    expect(referenceText("fig:x", "en", "see figure~")).toBe("@fig:x");
    expect(referenceText("fig:x", "es", "la Figura\u00a0")).toBe("@fig:x");
    expect(referenceText("eq:h", "fr", "par l'Équation ")).toBe("@eq:h");
    expect(referenceText("sec:m", "en", "Section")).toBe(" @sec:m");
  });

  it("only counts the name as a whole word", () => {
    expect(referenceText("tbl:r", "en", "Timetable ")).toBe("Table @tbl:r");
    expect(referenceText("fig:x", "en", "Figure 2 and ")).toBe("Figure @fig:x");
  });
});

describe("refDetail", () => {
  it("shows kind, number and page once compiled", () => {
    expect(refDetail("fig:x", { number: "2", page: "3" })).toBe("Figure 2 · p. 3");
    expect(refDetail("sec:m", { number: "2.1", page: "iv" })).toBe("Section 2.1 · p. iv");
    expect(refDetail("sec:n", { number: "", page: "5" })).toBe("Section · p. 5");
  });

  it("shows only the kind before the first compile", () => {
    expect(refDetail("tbl:r", undefined)).toBe("Table");
  });
});
