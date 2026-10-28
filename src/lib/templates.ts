import type { TemplateId } from "./api";

export interface TemplateInfo {
  id: TemplateId;
  label: string;
  description: string;
  defaultBibStyle: string;
  /** Drives the gallery thumbnail. */
  layout: { columns: 1 | 2; chapters: boolean; margins: "normal" | "wide" };
}

export const TEMPLATES: TemplateInfo[] = [
  {
    id: "article",
    label: "Article",
    description: "Generic one-column article (A4, 11pt)",
    defaultBibStyle: "plainnat",
    layout: { columns: 1, chapters: false, margins: "normal" },
  },
  {
    id: "ieee",
    label: "IEEE Conference",
    description: "IEEEtran, two columns, Times",
    defaultBibStyle: "IEEEtranN",
    layout: { columns: 2, chapters: false, margins: "normal" },
  },
  {
    id: "acm",
    label: "ACM (sigconf)",
    description: "acmart sigconf, two columns",
    defaultBibStyle: "ACM-Reference-Format",
    layout: { columns: 2, chapters: false, margins: "normal" },
  },
  {
    id: "elsevier",
    label: "Elsevier",
    description: "elsarticle preprint, one column",
    defaultBibStyle: "elsarticle-num-names",
    layout: { columns: 1, chapters: false, margins: "normal" },
  },
  {
    id: "lncs",
    label: "Springer LNCS",
    description: "llncs, Lecture Notes in Computer Science",
    defaultBibStyle: "splncs04",
    layout: { columns: 1, chapters: false, margins: "wide" },
  },
  {
    id: "report",
    label: "Thesis / Report",
    description: "Chapters, one column, A4 12pt",
    defaultBibStyle: "plainnat",
    layout: { columns: 1, chapters: true, margins: "normal" },
  },
  {
    id: "book",
    label: "Book",
    description: "Book class with chapters and two-sided pages",
    defaultBibStyle: "plainnat",
    layout: { columns: 1, chapters: true, margins: "wide" },
  },
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

/** Whether Markdown `#` is a chapter (report, book) rather than a section. */
export function usesChapters(id: TemplateId | undefined): boolean {
  return id !== undefined && templateInfo(id).layout.chapters;
}

/** What one `#` heading — and so one part — is called in this template. */
export function unitName(id: TemplateId | undefined): "chapter" | "section" {
  return usesChapters(id) ? "chapter" : "section";
}
