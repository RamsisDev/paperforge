import type { Layout, MarginUnit, Margins } from "./api";

export const DEFAULT_LAYOUT: Layout = {
  margins: { unit: "cm", top: 2.5, bottom: 2.5, left: 2.5, right: 2.5 },
  lineSpacing: "single",
  font: "latinModern",
  header: { left: "", center: "", right: "" },
  footer: { left: "", center: "", right: "" },
  lineNumbers: false,
};

/** A `paper.json` written before page setup, or with only some keys, gets the defaults. */
export function layoutOf(layout: Partial<Layout> | undefined): Layout {
  return {
    ...DEFAULT_LAYOUT,
    ...layout,
    margins: { ...DEFAULT_LAYOUT.margins, ...layout?.margins },
    header: { ...DEFAULT_LAYOUT.header, ...layout?.header },
    footer: { ...DEFAULT_LAYOUT.footer, ...layout?.footer },
  };
}

/** Class option → width × height in mm, as the standard classes define them. */
export const PAPERS = [
  { option: "a4paper", label: "A4", size: [210, 297] },
  { option: "letterpaper", label: "US Letter", size: [215.9, 279.4] },
  { option: "a5paper", label: "A5", size: [148, 210] },
  { option: "b5paper", label: "B5", size: [176, 250] },
  { option: "legalpaper", label: "US Legal", size: [215.9, 355.6] },
  { option: "executivepaper", label: "Executive", size: [184.15, 266.7] },
] as const;

export const FONT_SIZES = ["10pt", "11pt", "12pt"] as const;

const MM_PER: Record<MarginUnit, number> = { cm: 10, mm: 1, in: 25.4 };
/** Mirrors the backend's clamp: wider than this is a typo, not a margin. */
export const MAX_MARGIN: Record<MarginUnit, number> = { cm: 10, mm: 100, in: 4 };

export function toMm(value: number, unit: MarginUnit): number {
  return value * MM_PER[unit];
}

export function clampMargin(value: number, unit: MarginUnit): number {
  return Math.round(Math.min(Math.max(value, 0), MAX_MARGIN[unit]) * 100) / 100;
}

/** The same margins in another unit, rounded to what the field shows. */
export function convertMargins(m: Margins, unit: MarginUnit): Margins {
  const convert = (v: number) => clampMargin(toMm(v, m.unit) / MM_PER[unit], unit);
  return { unit, top: convert(m.top), bottom: convert(m.bottom), left: convert(m.left), right: convert(m.right) };
}

export function isUniform(m: Margins): boolean {
  return m.top === m.bottom && m.top === m.left && m.top === m.right;
}

export type OptionKind = "paper" | "size" | "columns";

/** The backend's option kinds for the class options page setup edits. */
export function optionKind(option: string): OptionKind | null {
  if (/^\d+(\.\d+)?pt$/.test(option)) return "size";
  if (option.endsWith("paper")) return "paper";
  if (option === "onecolumn" || option === "twocolumn") return "columns";
  return null;
}

/** The paper's option of `kind`, or `fallback` (the template's own) when it has none. */
export function classOption(options: string[], kind: OptionKind, fallback: string): string {
  return options.find((o) => optionKind(o) === kind) ?? fallback;
}

/** Replaces the options of `kind` with `value`; the template's default needs no option. */
export function withClassOption(options: string[], kind: OptionKind, value: string, fallback: string): string[] {
  const rest = options.filter((o) => optionKind(o) !== kind);
  return value === fallback ? rest : [...rest, value];
}
