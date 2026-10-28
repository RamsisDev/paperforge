import type { GrammarDialect } from "./protocol";

const REGIONS: Record<string, GrammarDialect> = {
  gb: "British",
  uk: "British",
  au: "Australian",
  nz: "Australian",
  ca: "Canadian",
  in: "Indian",
};

/** The English dialect to check a `meta.language` such as "en" or "en-GB" with; null for other languages. */
export function dialectFor(language: string | undefined): GrammarDialect | null {
  const [base, region] = (language || "en").toLowerCase().split(/[-_]/);
  if (base !== "en") return null;
  return REGIONS[region ?? ""] ?? "American";
}
