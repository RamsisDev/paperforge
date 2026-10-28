import { call as invoke } from "./platform";

export type TemplateId = "article" | "ieee" | "acm" | "elsevier" | "lncs" | "report" | "book";

export interface Author {
  name: string;
  affiliation: string;
  email: string;
}

export interface PaperMeta {
  template: TemplateId;
  title: string;
  authors: Author[];
  abstract: string;
  keywords: string[];
  language: string;
  date: string;
  bibStyle: string;
  /** Ordered project-relative Markdown files, e.g. "sections/introduction.md". */
  parts: string[];
  toc: boolean;
  lof: boolean;
  lot: boolean;
  /** 1..3 */
  tocDepth: number;
}

export interface Part {
  file: string;
  content: string;
}

export interface ProjectSnapshot {
  dir: string;
  meta: PaperMeta;
  parts: Part[];
  bib: string;
  figures: string[];
}

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  stage: "pandoc" | "latex" | "bibtex";
  message: string;
  /** Generated file: "paper.tex", "part-<x>.tex" or "refs.bib". */
  file: string | null;
  /** 1-based line in `file`. */
  line: number | null;
  /** Text of that generated line. */
  source: string | null;
  /** The Markdown part the generated line came from. */
  part: string | null;
  /** 1-based line in `part` the generated line came from, by the fragment's block markers. */
  partLine?: number | null;
}

/** A Markdown line of a part; `line` is 1-based. */
export interface SourceSpot {
  part: string;
  line: number;
}

/** A region of a PDF page: 1-based page, PDF points from the top left. */
export interface PdfBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TocEntry {
  list: "toc" | "lof" | "lot";
  level: string;
  depth: number;
  /** "1.2", or "" for unnumbered entries. */
  number: string;
  title: string;
  /** As LaTeX printed it: "3", "iv". */
  page: string;
}

export interface CompileOutcome {
  ok: boolean;
  cancelled: boolean;
  pdfPath: string | null;
  diagnostics: Diagnostic[];
  pandocMs: number;
  texMs: number;
  usedNetwork: boolean;
  needsRerun: boolean;
  toc: TocEntry[];
  convertedParts: number;
}

export type CompileMode = "preview" | "full";

export interface EngineInfo {
  pandoc: string;
  tectonic: string;
  texCache: string;
  bundleUrl: string;
}

export const api = {
  engineInfo: () => invoke<EngineInfo>("engine_info"),
  startupProject: () => invoke<string | null>("startup_project"),
  createProject: (dir: string, template: TemplateId, title: string, language: string, sample: boolean) =>
    invoke<ProjectSnapshot>("project_create", { dir, template, title, language, sample }),
  openProject: (dir: string) => invoke<ProjectSnapshot>("project_open", { dir }),
  save: (dir: string, fields: { meta?: PaperMeta; bib?: string }) => invoke<void>("project_save", { dir, ...fields }),
  savePart: (dir: string, file: string, content: string) => invoke<void>("part_save", { dir, file, content }),
  createPart: (dir: string, index: number, title: string) =>
    invoke<ProjectSnapshot>("part_create", { dir, index, title }),
  deletePart: (dir: string, file: string) => invoke<ProjectSnapshot>("part_delete", { dir, file }),
  reorderParts: (dir: string, parts: string[]) => invoke<ProjectSnapshot>("parts_reorder", { dir, parts }),
  splitPart: (dir: string, file: string, level: 1 | 2) => invoke<ProjectSnapshot>("part_split", { dir, file, level }),
  mergeParts: (dir: string, files: string[]) => invoke<ProjectSnapshot>("parts_merge", { dir, files }),
  importFigure: (dir: string, source: string) => invoke<string>("figure_import", { dir, source }),
  listFigures: (dir: string) => invoke<string[]>("figure_list", { dir }),
  /** Raw bytes over IPC: no JSON number arrays for multi-megabyte PDFs. */
  readBinary: (path: string) => invoke<ArrayBuffer>("read_binary", { path }),
  readTex: (dir: string) => invoke<string>("read_tex", { dir }),
  compile: (dir: string, mode: CompileMode, focus: string | null) =>
    invoke<CompileOutcome>("compile", { dir, mode, focus }),
  exportPdf: (dir: string, dest: string) => invoke<void>("export_pdf", { dir, dest }),
  exportZip: (dir: string, dest: string) => invoke<void>("export_zip", { dir, dest }),
  /** Browser only: folders for the in-page folder picker. */
  browse: (path: string | null) => invoke<FolderListing>("_browse", { path }),
  /** The Markdown line typeset at a spot of the last compiled PDF; null without SyncTeX data. */
  synctexToSource: (dir: string, page: number, x: number, y: number) =>
    invoke<SourceSpot | null>("synctex_to_source", { dir, page, x, y }),
  /** Where a Markdown line (1-based) of a part was typeset; null without SyncTeX data. */
  synctexToPdf: (dir: string, part: string, line: number) =>
    invoke<PdfBox | null>("synctex_to_pdf", { dir, part, line }),
  readDictionary: (dir: string) => invoke<string[]>("dictionary_read", { dir }),
  /** Appends new words to the project dictionary; returns the whole list. */
  addToDictionary: (dir: string, words: string[]) => invoke<string[]>("dictionary_add", { dir, words }),
};

export interface FolderListing {
  path: string;
  parent: string | null;
  home: string | null;
  isProject: boolean;
  dirs: { name: string; path: string; isProject: boolean }[];
}

export function joinPath(dir: string, rel: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${rel.replace(/\//g, sep)}`;
}

export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}
