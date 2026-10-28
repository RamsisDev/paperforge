import { create } from "zustand";
import { escapeRegExp, type FindOptions } from "@/editor/findAcrossParts";
import type { Diagnostic, LabelRef, PaperMeta, Part, TocEntry } from "@/lib/api";

export const BIB_FILE = "refs.bib";
export const TEX_FILE = "paper.tex";
export const PREAMBLE_FILE = "preamble.tex";

/** A Markdown part path, `BIB_FILE`, `TEX_FILE` or `PREAMBLE_FILE`. */
export type EditorFile = string;
export type SidebarTab = "paper" | "structure" | "refs" | "figures" | "find" | "comments";
export type Theme = "light" | "dark";
/** "writing" renders the Markdown in place; "source" shows it as typed. */
export type EditorMode = "writing" | "source";
export type GalleryMode = "create" | "change";

export function isPartFile(file: EditorFile): boolean {
  return file !== BIB_FILE && file !== TEX_FILE && file !== PREAMBLE_FILE;
}

export interface CompileStatus {
  state: "idle" | "running" | "ok" | "error";
  /** Pandoc + TeX time of the last finished compile. */
  ms: number | null;
  usedNetwork: boolean;
  passes: number;
}

export interface Jump {
  file: EditorFile;
  /** 0-based line. */
  line: number;
  /** Text to select instead of placing the cursor at the line start. */
  select?: { from: number; to: number };
  nonce: number;
}

export interface FindState extends FindOptions {
  replace: string;
  /** Bumped to focus the query field. */
  focus: number;
}

interface State {
  dir: string | null;
  meta: PaperMeta | null;
  parts: Part[];
  bib: string;
  tex: string;
  /** `preamble.tex`, null while the project has none. */
  preamble: string | null;
  figures: string[];

  activeFile: EditorFile;
  saveState: "saved" | "pending" | "saving" | "error";
  saveError: string | null;
  compile: CompileStatus;
  diagnostics: Diagnostic[];
  /** Contents, figures and tables of the last successful compile, as LaTeX numbered them. */
  toc: TocEntry[];
  /** Label → printed number and page, from the last successful compile. */
  labels: Record<string, LabelRef>;
  pdf: { data: Uint8Array; version: number } | null;

  theme: Theme;
  editorMode: EditorMode;
  sidebarTab: SidebarTab;
  sidebarOpen: boolean;
  problemsOpen: boolean;
  cursor: { line: number; col: number };
  /** Preview compiles only the chapter being edited (report and book templates). */
  previewFocus: boolean;
  gallery: GalleryMode | null;
  /** Index where the Structure tab is asking for a new part's title. */
  addingPart: number | null;

  jump: Jump | null;
  previewReveal: { text: string; nonce: number } | null;
  pageReveal: { page: number; nonce: number } | null;
  contentsReveal: number;
  find: FindState;
  /** The name new comments are signed with; "" until the user gives one. */
  commentAuthor: string;
  /** Compiles produce the review PDF (comments rendered) instead of the final one. */
  reviewMode: boolean;
}

const storedTheme = (localStorage.getItem("paperforge.theme") as Theme | null) ??
  (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

const storedEditorMode: EditorMode = localStorage.getItem("paperforge.editorMode") === "writing" ? "writing" : "source";

export const initialProjectState = {
  dir: null,
  meta: null,
  parts: [] as Part[],
  bib: "",
  tex: "",
  preamble: null,
  figures: [],
  activeFile: "" as EditorFile,
  saveState: "saved" as const,
  saveError: null,
  compile: { state: "idle", ms: null, usedNetwork: false, passes: 0 } as CompileStatus,
  diagnostics: [],
  toc: [],
  labels: {} as Record<string, LabelRef>,
  pdf: null,
  addingPart: null,
  jump: null,
  previewReveal: null,
  pageReveal: null,
  reviewMode: false,
};

export const useStore = create<State>(() => ({
  ...initialProjectState,
  theme: storedTheme,
  editorMode: storedEditorMode,
  sidebarTab: "paper",
  sidebarOpen: true,
  problemsOpen: false,
  cursor: { line: 1, col: 1 },
  previewFocus: localStorage.getItem("paperforge.previewFocus") === "1",
  gallery: null,
  contentsReveal: 0,
  find: { query: "", replace: "", regex: false, matchCase: false, wholeWord: false, skipMarkup: false, focus: 0 },
  commentAuthor: localStorage.getItem("paperforge.commentAuthor") ?? "",
}));

export const store = {
  get: useStore.getState,
  set: useStore.setState,
};

/** What the last successful compile printed for `label` (e.g. "fig:x"); undefined before it. */
export function labelRef(label: string): LabelRef | undefined {
  return store.get().labels[label];
}

export function useLabelRef(label: string): LabelRef | undefined {
  return useStore((s) => s.labels[label]);
}

let nonce = 0;

export function jumpTo(file: EditorFile, line: number) {
  store.set({ activeFile: file, jump: { file, line, nonce: ++nonce } });
}

/** Opens `file` with `from`..`to` selected; `line` is the 0-based line of `from`. */
export function selectInFile(file: EditorFile, line: number, from: number, to: number) {
  store.set({ activeFile: file, jump: { file, line, select: { from, to }, nonce: ++nonce } });
}

/** Opens the Find tab, searching for `query` when given. */
export function openFind(query?: string) {
  store.set((s) => ({
    sidebarOpen: true,
    sidebarTab: "find",
    find: {
      ...s.find,
      query: query === undefined ? s.find.query : s.find.regex ? escapeRegExp(query) : query,
      focus: s.find.focus + 1,
    },
  }));
}

export function updateFind(patch: Partial<Omit<FindState, "focus">>) {
  store.set((s) => ({ find: { ...s.find, ...patch } }));
}

export function openFile(file: EditorFile) {
  store.set({ activeFile: file });
}

export function revealInPreview(text: string) {
  store.set({ previewReveal: { text, nonce: ++nonce } });
}

/** Scrolls the preview to a printed (arabic) page number. */
export function revealPage(page: number) {
  store.set({ pageReveal: { page, nonce: ++nonce } });
}

export function openGallery(mode: GalleryMode) {
  store.set({ gallery: mode });
}

/** Opens the Paper tab at its Contents settings. */
export function showContentsSettings() {
  store.set((s) => ({ sidebarOpen: true, sidebarTab: "paper", contentsReveal: s.contentsReveal + 1 }));
}

/** Opens the Structure tab asking for the title of a part to insert at `index`. */
export function askNewPart(index: number) {
  store.set({ sidebarOpen: true, sidebarTab: "structure", addingPart: index });
}

export function setTheme(theme: Theme) {
  localStorage.setItem("paperforge.theme", theme);
  store.set({ theme });
}

export function setEditorMode(editorMode: EditorMode) {
  localStorage.setItem("paperforge.editorMode", editorMode);
  store.set({ editorMode });
}

export function setCommentAuthor(name: string) {
  const commentAuthor = name.trim();
  localStorage.setItem("paperforge.commentAuthor", commentAuthor);
  store.set({ commentAuthor });
}
