import type { PaperMeta, Style } from "./api";
import builtins from "./builtinStyles.json";

export interface BuiltinStyle extends Style {
  label: string;
}

/** Offered in the UI; a project stores only the styles it adds. */
export const BUILTIN_STYLES = builtins as BuiltinStyle[];

export function projectStyles(meta: PaperMeta | null | undefined): Style[] {
  return meta?.styles ?? [];
}

export function builtinStyle(name: string): BuiltinStyle | undefined {
  return BUILTIN_STYLES.find((s) => s.name === name);
}

/** Same rule as `styles.rs`: lowercase words of letters and digits joined by single hyphens. */
export function validStyleName(name: string): boolean {
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name);
}

/** Why `style` would not compile, or null. Mirrors `styles::validate`. */
export function styleProblem(style: Style, others: Style[]): string | null {
  if (!validStyleName(style.name)) return "Use lowercase letters and digits, words joined by single hyphens.";
  if (others.some((s) => s !== style && s.name === style.name)) return `Another style is named "${style.name}".`;
  const holes = style.latex.split("#1").length - 1;
  if (holes === 0) return "Put #1 where the text goes.";
  if (style.kind === "paragraph" && holes > 1) return "A paragraph style uses #1 once.";
  return null;
}

function commandName(name: string): string {
  return `\\pfstyle${name.replace(/[0-9]/g, (d) => String.fromCharCode(65 + Number(d))).replace(/-/g, "Z")}`;
}

/** The preamble line the compiler generates for `style`. */
export function styleDefinition(style: Style): string {
  const latex = style.latex.trim();
  if (style.kind === "character") return `\\newcommand{${commandName(style.name)}}[1]{${latex}}`;
  const at = latex.indexOf("#1");
  const [begin, end] = at < 0 ? [latex, ""] : [latex.slice(0, at), latex.slice(at + 2)];
  return `\\newenvironment{pf-${style.name}}{${begin.trim()}}{${end.trim()}}`;
}

/** How the style is written in Markdown. */
export function styleSyntax(style: Style): string {
  return style.kind === "paragraph" ? `::: {.${style.name}}` : `[text]{.${style.name}}`;
}
