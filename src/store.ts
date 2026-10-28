import { create } from "zustand";
import type { Diagnostic, PaperMeta } from "@/lib/api";

export type EditorFile = "paper.md" | "refs.bib" | "paper.tex";
export type SidebarTab = "paper" | "outline" | "refs" | "figures";
export type Theme = "light" | "dark";

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
  nonce: number;
}

interface State {
  dir: string | null;
  meta: PaperMeta | null;
  body: string;
  bib: string;
  tex: string;
  figures: string[];

  activeFile: EditorFile;
  saveState: "saved" | "pending" | "saving" | "error";
  saveError: string | null;
  compile: CompileStatus;
  diagnostics: Diagnostic[];
  pdf: { data: Uint8Array; version: number } | null;

  theme: Theme;
  sidebarTab: SidebarTab;
  sidebarOpen: boolean;
  problemsOpen: boolean;
  cursor: { line: number; col: number };

  jump: Jump | null;
  previewReveal: { text: string; nonce: number } | null;
}

const storedTheme = (localStorage.getItem("paperforge.theme") as Theme | null) ??
  (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

export const initialProjectState = {
  dir: null,
  meta: null,
  body: "",
  bib: "",
  tex: "",
  figures: [],
  activeFile: "paper.md" as EditorFile,
  saveState: "saved" as const,
  saveError: null,
  compile: { state: "idle", ms: null, usedNetwork: false, passes: 0 } as CompileStatus,
  diagnostics: [],
  pdf: null,
  jump: null,
  previewReveal: null,
};

export const useStore = create<State>(() => ({
  ...initialProjectState,
  theme: storedTheme,
  sidebarTab: "paper",
  sidebarOpen: true,
  problemsOpen: false,
  cursor: { line: 1, col: 1 },
}));

export const store = {
  get: useStore.getState,
  set: useStore.setState,
};

let nonce = 0;

export function jumpTo(file: EditorFile, line: number) {
  store.set({ activeFile: file, jump: { file, line, nonce: ++nonce } });
}

export function revealInPreview(text: string) {
  store.set({ previewReveal: { text, nonce: ++nonce } });
}

export function setTheme(theme: Theme) {
  localStorage.setItem("paperforge.theme", theme);
  store.set({ theme });
}
