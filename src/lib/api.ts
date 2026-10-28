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
  /** `\documentclass` options; each replaces the template's default of the same kind. */
  classOptions: string[];
  /** Project copy of the template from "Eject template", e.g. "template/article.tex"; "" for the built-in one. */
  templateFile: string;
  /** Page setup of the generic templates; paper size, font size and columns are `classOptions`. */
  layout: Layout;
  /** Div and span classes typeset with their LaTeX; absent until the project has one. */
  styles?: Style[];
}

export type MarginUnit = "cm" | "mm" | "in";
export type LineSpacing = "single" | "onehalf" | "double";
export type MainFont = "latinModern" | "termes" | "libertine";

export interface Margins {
  unit: MarginUnit;
  top: number;
  bottom: number;
  /** The inner margin on two-sided pages. */
  left: number;
  right: number;
}

/** Header or footer text; "{page}" prints the page number. */
export interface Slots {
  left: string;
  center: string;
  right: string;
}

export interface Layout {
  margins: Margins;
  lineSpacing: LineSpacing;
  font: MainFont;
  header: Slots;
  footer: Slots;
  lineNumbers: boolean;
}

export type StyleKind = "paragraph" | "character";

export interface Style {
  /** The div (`::: {.name}`) or span (`[text]{.name}`) class. */
  name: string;
  kind: StyleKind;
  /** LaTeX around `#1`, which stands for the styled text. */
  latex: string;
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
  /** `preamble.tex`, null until created. */
  preamble: string | null;
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

/** What `\ref` and `\pageref` print for a label. */
export interface LabelRef {
  /** "2", "3.1"; "" outside any numbered unit. */
  number: string;
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
  /** Label → printed number and page; empty unless `ok`. */
  labels: Record<string, LabelRef>;
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
  /** With `review`, the review PDF: comments rendered, in a build directory of its own. */
  compile: (dir: string, mode: CompileMode, focus: string | null, review = false) =>
    invoke<CompileOutcome>("compile", { dir, mode, focus, review }),
  exportPdf: (dir: string, dest: string, review = false) => invoke<void>("export_pdf", { dir, dest, review }),
  exportZip: (dir: string, dest: string) => invoke<void>("export_zip", { dir, dest }),
  /** Browser only: folders for the in-page folder picker. */
  browse: (path: string | null) => invoke<FolderListing>("_browse", { path }),
  /** The Markdown line typeset at a spot of the last compiled PDF; null without SyncTeX data. */
  synctexToSource: (dir: string, page: number, x: number, y: number, review = false) =>
    invoke<SourceSpot | null>("synctex_to_source", { dir, page, x, y, review }),
  /** Where a Markdown line (1-based) of a part was typeset; null without SyncTeX data. */
  synctexToPdf: (dir: string, part: string, line: number, review = false) =>
    invoke<PdfBox | null>("synctex_to_pdf", { dir, part, line, review }),
  readDictionary: (dir: string) => invoke<string[]>("dictionary_read", { dir }),
  /** Appends new words to the project dictionary; returns the whole list. */
  addToDictionary: (dir: string, words: string[]) => invoke<string[]>("dictionary_add", { dir, words }),
  /** A pasted figure: `data` is base64. Returns the project-relative path. */
  importFigureBytes: (dir: string, name: string, data: string) =>
    invoke<string>("figure_import_bytes", { dir, name, data }),
  savePreamble: (dir: string, content: string) => invoke<void>("preamble_save", { dir, content }),
  /** Copies the template into the project's template/ folder and compiles with that copy. */
  ejectTemplate: (dir: string) => invoke<ProjectSnapshot>("template_eject", { dir }),
  restoreTemplate: (dir: string) => invoke<ProjectSnapshot>("template_restore", { dir }),
  /** A DOI or arXiv id as one BibTeX entry, under a key not in `existingKeys`. Needs the network. */
  bibLookup: (query: string, existingKeys: string[]) => invoke<BibLookup>("bib_lookup", { query, existingKeys }),
  /** The absolute path of the external .bib linked to the project (e.g. a Zotero export). */
  zoteroLinked: (dir: string) => invoke<string | null>("zotero_linked", { dir }),
  /** Links an external .bib, or unlinks with null; returns the new link. */
  zoteroLink: (dir: string, path: string | null) => invoke<string | null>("zotero_link", { dir, path }),
  zoteroRead: (dir: string) => invoke<string | null>("zotero_read", { dir }),
  /** Starts watching the linked .bib (desktop only); false when nothing is watched. */
  zoteroWatch: (dir: string) => invoke<boolean>("zotero_watch", { dir }),
  /**
   * The generated LaTeX of the top-level block around a Markdown line (1-based) of a part, from
   * its last fragment; `content` is the part as edited. Null before the part was typeset.
   */
  blockLatex: (dir: string, part: string, line: number, content: string) =>
    invoke<BlockLatex | null>("block_latex", { dir, part, line, content }),
  historyStatus: (dir: string) => invoke<HistoryStatus>("history_status", { dir }),
  /** Starts version history in the project folder (or adopts its git repository). */
  historyEnable: (dir: string) => invoke<HistoryStatus>("history_enable", { dir }),
  /** Null when history is off or nothing changed since the last snapshot. */
  historyAutosave: (dir: string, reason: string | null = null) =>
    invoke<VersionInfo | null>("history_autosave", { dir, reason }),
  /**
   * A `label` also names the version (a milestone); `reason` replaces the automatic summary, e.g.
   * "PDF exported". Null when nothing changed and there is nothing to name.
   */
  historySaveVersion: (dir: string, opts: { label?: string; note?: string; reason?: string } = {}) =>
    invoke<VersionInfo | null>("history_save_version", {
      dir,
      label: opts.label ?? null,
      note: opts.note ?? null,
      reason: opts.reason ?? null,
    }),
  /** Newest first; `before` is the id of the oldest entry already shown. */
  historyList: (dir: string, includeAutosaves: boolean, before: string | null, limit: number) =>
    invoke<VersionInfo[]>("history_list", { dir, includeAutosaves, before, limit }),
  /** Names a version, or removes its name with null. */
  historyLabel: (dir: string, id: string, label: string | null) =>
    invoke<VersionInfo>("history_label", { dir, id, label }),
  /** From one snapshot to another, or to the working copy when `to` is null. */
  historyDiff: (dir: string, from: string, to: string | null) => invoke<VersionDiff>("history_diff", { dir, from, to }),
  historyReadPart: (dir: string, id: string, file: string) => invoke<string>("history_read_part", { dir, id, file }),
  historyRestore: (dir: string, id: string) => invoke<ProjectSnapshot>("history_restore", { dir, id }),
  /** Brings one part back, re-inserting it when it was deleted since. */
  historyRestorePart: (dir: string, id: string, file: string) =>
    invoke<ProjectSnapshot>("history_restore_part", { dir, id, file }),
  /** Desktop: quits the app, once pending edits are saved. */
  appQuit: () => invoke<void>("app_quit"),
};

/** "own": enabled by PaperForge; "adopted": the folder already was a git repository. */
export type RepoMode = "own" | "adopted" | "parentRepo" | "none";

export interface HistoryStatus {
  enabled: boolean;
  mode: RepoMode;
  branch: string | null;
  /** The project differs from the last version. */
  dirty: boolean;
  lastVersion: VersionInfo | null;
  remote: string | null;
}

export type VersionKind = "autosave" | "version";

export interface VersionInfo {
  id: string;
  shortId: string;
  kind: VersionKind;
  /** Milestone name, e.g. "Sent to reviewer". */
  label: string | null;
  note: string | null;
  /** e.g. "Edited: Introduction, Method". */
  summary: string;
  /** Unix seconds. */
  time: number;
  author: string;
  /** Project-relative files changed since the previous snapshot. */
  changedParts: string[];
}

export type ChangeStatus = "added" | "deleted" | "modified" | "renamed";

export interface DiffSegment {
  kind: "equal" | "insert" | "delete";
  text: string;
}

export interface PartDiff {
  file: string;
  oldFile: string | null;
  /** First heading of the part, else its file name. */
  title: string;
  status: ChangeStatus;
  /** The whole text; long unchanged runs are folded by the UI. */
  segments: DiffSegment[];
}

export interface VersionDiff {
  from: string;
  /** Null: the working copy. */
  to: string | null;
  parts: PartDiff[];
  /** Plain-language changes of the paper settings, e.g. "Title: “A” → “B”". */
  meta: { field: string; description: string }[];
  bib: { key: string; status: ChangeStatus }[];
  files: { path: string; oldPath: string | null; status: ChangeStatus }[];
}

export interface BlockLatex {
  /** The block's lines in the part's fragment, 1-based and inclusive. */
  fromLine: number;
  toLine: number;
  /** The block's Markdown lines, 1-based and inclusive. */
  markdownFrom: number;
  markdownTo: number;
  latex: string;
  /** The part changed after it was last typeset. */
  stale: boolean;
}

export interface BibLookup {
  key: string;
  bibtex: string;
}

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
