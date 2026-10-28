import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAYOUT,
  classOption,
  clampMargin,
  convertMargins,
  isUniform,
  layoutOf,
  optionKind,
  withClassOption,
} from "./pageSetup";
import { TEMPLATES } from "./templates";

describe("page setup", () => {
  it("fills a missing or partial layout with the defaults", () => {
    expect(layoutOf(undefined)).toEqual(DEFAULT_LAYOUT);
    const partial = layoutOf({ lineNumbers: true, margins: { top: 3 } } as never);
    expect(partial.lineNumbers).toBe(true);
    expect(partial.margins).toEqual({ ...DEFAULT_LAYOUT.margins, top: 3 });
    expect(partial.footer).toEqual(DEFAULT_LAYOUT.footer);
  });

  it("converts and clamps margins", () => {
    const cm = { unit: "cm" as const, top: 2.5, bottom: 2.5, left: 3, right: 50 };
    expect(convertMargins(cm, "mm")).toEqual({ unit: "mm", top: 25, bottom: 25, left: 30, right: 100 });
    expect(convertMargins(cm, "in")).toEqual({ unit: "in", top: 0.98, bottom: 0.98, left: 1.18, right: 4 });
    expect(clampMargin(-1, "cm")).toBe(0);
    expect(clampMargin(1.234, "in")).toBe(1.23);
    expect(isUniform(DEFAULT_LAYOUT.margins)).toBe(true);
    expect(isUniform(cm)).toBe(false);
  });

  it("edits one kind of class option and leaves the others", () => {
    expect(optionKind("10pt")).toBe("size");
    expect(optionKind("letterpaper")).toBe("paper");
    expect(optionKind("twocolumn")).toBe("columns");
    expect(optionKind("draft")).toBeNull();
    const options = ["draft", "10pt"];
    expect(classOption(options, "size", "11pt")).toBe("10pt");
    expect(classOption(options, "paper", "a4paper")).toBe("a4paper");
    expect(withClassOption(options, "size", "12pt", "11pt")).toEqual(["draft", "12pt"]);
    expect(withClassOption(options, "size", "11pt", "11pt")).toEqual(["draft"]);
    expect(withClassOption(options, "columns", "twocolumn", "onecolumn")).toEqual(["draft", "10pt", "twocolumn"]);
  });

  it("knows each generic template's own paper and font size", () => {
    for (const t of TEMPLATES) {
      const tex = readFileSync(`src-tauri/resources/templates/${t.id}.tex`, "utf8");
      const defaults = /^\$-- classoption: (.*)$/m.exec(tex)![1].split(",").map((o) => o.trim());
      const usesLayout = tex.includes("\\usepackage[$geometry$]{geometry}");
      expect(Boolean(t.page), t.id).toBe(usesLayout);
      if (t.page) expect(defaults, t.id).toEqual(expect.arrayContaining([t.page.paper, t.page.fontSize]));
    }
  });
});
