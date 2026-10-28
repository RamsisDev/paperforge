import { invoke } from "@tauri-apps/api/core";

export type TemplateId = "article" | "ieee" | "acm" | "elsevier" | "lncs";

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
}

export interface ProjectSnapshot {
  dir: string;
  meta: PaperMeta;
  body: string;
  bib: string;
  figures: string[];
}

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  stage: "pandoc" | "latex" | "bibtex";
  message: string;
  file: string | null;
  line: number | null;
  source: string | null;
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
  createProject: (dir: string, sample: boolean) =>
    invoke<ProjectSnapshot>("project_create", { dir, sample }),
  openProject: (dir: string) => invoke<ProjectSnapshot>("project_open", { dir }),
  save: (dir: string, parts: { meta?: PaperMeta; body?: string; bib?: string }) =>
    invoke<void>("project_save", { dir, ...parts }),
  importFigure: (dir: string, source: string) => invoke<string>("figure_import", { dir, source }),
  listFigures: (dir: string) => invoke<string[]>("figure_list", { dir }),
  /** Raw bytes over IPC: no JSON number arrays for multi-megabyte PDFs. */
  readBinary: (path: string) => invoke<ArrayBuffer>("read_binary", { path }),
  readTex: (dir: string) => invoke<string>("read_tex", { dir }),
  compile: (dir: string, mode: CompileMode) => invoke<CompileOutcome>("compile", { dir, mode }),
  exportPdf: (dir: string, dest: string) => invoke<void>("export_pdf", { dir, dest }),
  exportZip: (dir: string, dest: string) => invoke<void>("export_zip", { dir, dest }),
};

export function joinPath(dir: string, rel: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${rel.replace(/\//g, sep)}`;
}

export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}
