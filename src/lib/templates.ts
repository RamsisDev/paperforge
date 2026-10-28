import type { TemplateId } from "./api";

export interface TemplateInfo {
  id: TemplateId;
  label: string;
  description: string;
  defaultBibStyle: string;
}

export const TEMPLATES: TemplateInfo[] = [
  { id: "article", label: "Article", description: "Generic one-column article (A4, 11pt)", defaultBibStyle: "plainnat" },
  { id: "ieee", label: "IEEE Conference", description: "IEEEtran, two columns, Times", defaultBibStyle: "IEEEtranN" },
  { id: "acm", label: "ACM (sigconf)", description: "acmart sigconf, two columns", defaultBibStyle: "ACM-Reference-Format" },
  { id: "elsevier", label: "Elsevier", description: "elsarticle preprint, one column", defaultBibStyle: "elsarticle-num-names" },
  { id: "lncs", label: "Springer LNCS", description: "llncs, Lecture Notes in Computer Science", defaultBibStyle: "splncs04" },
];

export const LANGUAGES = [
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
  { id: "pt", label: "Português" },
  { id: "fr", label: "Français" },
  { id: "de", label: "Deutsch" },
  { id: "it", label: "Italiano" },
];

export function templateInfo(id: TemplateId): TemplateInfo {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}
