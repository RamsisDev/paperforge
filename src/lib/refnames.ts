import type { LabelRef } from "./api";

export type RefKind = "fig" | "tbl" | "eq" | "sec";

/** What the text calls a referenced figure, table, equation or section, per document language. */
const REF_NAMES: Record<string, Record<RefKind, string>> = {
  en: { fig: "Figure", tbl: "Table", eq: "Equation", sec: "Section" },
  es: { fig: "Figura", tbl: "Tabla", eq: "Ecuación", sec: "Sección" },
  pt: { fig: "Figura", tbl: "Tabela", eq: "Equação", sec: "Seção" },
  fr: { fig: "Figure", tbl: "Tableau", eq: "Équation", sec: "Section" },
  de: { fig: "Abbildung", tbl: "Tabelle", eq: "Gleichung", sec: "Abschnitt" },
  it: { fig: "Figura", tbl: "Tabella", eq: "Equazione", sec: "Sezione" },
};

/** The kind of a `fig:x` / `tbl:x` / `eq:x` / `sec:x` label; null for other labels. */
export function refKind(label: string): RefKind | null {
  const prefix = /^(fig|tbl|eq|sec):/.exec(label)?.[1];
  return (prefix as RefKind | undefined) ?? null;
}

/** The name for `kind` in a `meta.language` such as "es" or "pt-BR"; English when unknown. */
export function refName(kind: RefKind, language: string | undefined): string {
  const base = (language || "en").toLowerCase().split(/[-_]/)[0];
  return (REF_NAMES[base] ?? REF_NAMES.en)[kind];
}

/**
 * The text to insert for a reference to `label` after `before` (the text preceding the cursor):
 * `Figure @fig:x`, or only `@fig:x` when `before` already ends with the name.
 */
export function referenceText(label: string, language: string | undefined, before: string): string {
  const kind = refKind(label);
  if (!kind) return `@${label}`;
  const name = refName(kind, language);
  const named = new RegExp(`(?:^|[^\\p{L}])${name}([\\s~\\u00a0]*)$`, "iu").exec(before);
  if (named) return named[1] ? `@${label}` : ` @${label}`;
  return `${name} @${label}`;
}

/** Completion detail for a label: "Figure 2 · p. 3", or just "Figure" before the first compile. */
export function refDetail(label: string, ref: LabelRef | undefined): string {
  const kind = refKind(label);
  const name = kind ? refName(kind, "en") : "Label";
  if (!ref) return name;
  return [ref.number ? `${name} ${ref.number}` : name, ref.page && `p. ${ref.page}`].filter(Boolean).join(" · ");
}
