// Saving and compiling, kept outside React so typing never re-renders the tree.
//
// Edits are written after a short pause, and every save is followed by a preview compile.
// The backend aborts a running compile when a new one starts, so a stale result can only
// arrive out of order; `compileSeq` drops those.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, baseName, type CompileMode, type PaperMeta, type ProjectSnapshot } from "@/lib/api";
import { initialProjectState, store } from "@/store";
import { rememberProject } from "@/lib/recent";

const SAVE_DELAY_MS = 300;
const COMPILE_DELAY_MS = 150;
/** A new citation needs two passes after BibTeX; one more covers a label added in the same edit. */
const MAX_RERUNS = 3;

type Parts = { meta?: PaperMeta; body?: string; bib?: string };

let pending: Parts = {};
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let compileTimer: ReturnType<typeof setTimeout> | undefined;
let compileSeq = 0;
let savePromise: Promise<void> = Promise.resolve();

export function loadProject(snapshot: ProjectSnapshot) {
  clearTimeout(saveTimer);
  clearTimeout(compileTimer);
  pending = {};
  store.set({
    ...initialProjectState,
    dir: snapshot.dir,
    meta: snapshot.meta,
    body: snapshot.body,
    bib: snapshot.bib,
    figures: snapshot.figures,
  });
  rememberProject(snapshot.dir, snapshot.meta.title);
  void getCurrentWindow().setTitle(`${snapshot.meta.title || baseName(snapshot.dir)} — PaperForge`);
  scheduleCompile("full", 0);
}

export async function closeProject() {
  await flushSaves();
  store.set({ ...initialProjectState });
  void getCurrentWindow().setTitle("PaperForge");
}

function queueSave(parts: Parts) {
  Object.assign(pending, parts);
  store.set({ saveState: "pending" });
  clearTimeout(saveTimer);
  clearTimeout(compileTimer);
  saveTimer = setTimeout(() => void flushSaves().then(() => scheduleCompile("preview", COMPILE_DELAY_MS)), SAVE_DELAY_MS);
}

export function flushSaves(): Promise<void> {
  clearTimeout(saveTimer);
  savePromise = savePromise.then(async () => {
    const { dir } = store.get();
    const parts = pending;
    pending = {};
    if (!dir || Object.keys(parts).length === 0) return;
    store.set({ saveState: "saving" });
    try {
      await api.save(dir, parts);
      store.set({ saveState: Object.keys(pending).length ? "pending" : "saved", saveError: null });
    } catch (e) {
      pending = { ...parts, ...pending };
      store.set({ saveState: "error", saveError: String(e) });
    }
  });
  return savePromise;
}

export function setBody(body: string) {
  store.set({ body });
  queueSave({ body });
}

export function setBib(bib: string) {
  store.set({ bib });
  queueSave({ bib });
}

export function updateMeta(patch: Partial<PaperMeta>) {
  const meta = store.get().meta;
  if (!meta) return;
  const next = { ...meta, ...patch };
  store.set({ meta: next });
  queueSave({ meta: next });
  if (patch.title !== undefined) {
    void getCurrentWindow().setTitle(`${next.title || "Untitled"} — PaperForge`);
  }
}

export function scheduleCompile(mode: CompileMode, delay: number) {
  clearTimeout(compileTimer);
  compileTimer = setTimeout(() => void runCompile(mode, 0), delay);
}

/** Saves pending edits and runs a full compile; resolves with whether a fresh PDF exists. */
export async function compileNow(mode: CompileMode = "full"): Promise<boolean> {
  clearTimeout(compileTimer);
  await flushSaves();
  return runCompile(mode, 0);
}

async function runCompile(mode: CompileMode, rerun: number): Promise<boolean> {
  const dir = store.get().dir;
  if (!dir) return false;
  const seq = ++compileSeq;
  store.set((s) => ({ compile: { ...s.compile, state: "running" } }));
  try {
    const out = await api.compile(dir, mode);
    if (seq !== compileSeq || out.cancelled) return false;
    if (out.ok && out.pdfPath) {
      const bytes = new Uint8Array(await api.readBinary(out.pdfPath));
      if (seq !== compileSeq) return false;
      store.set((s) => ({ pdf: { data: bytes, version: (s.pdf?.version ?? 0) + 1 } }));
    }
    store.set({
      diagnostics: out.diagnostics,
      compile: {
        state: out.ok ? "ok" : "error",
        ms: out.pandocMs + out.texMs,
        usedNetwork: out.usedNetwork,
        passes: rerun + 1,
      },
    });
    if (store.get().activeFile === "paper.tex") void refreshTex();
    if (out.ok && out.needsRerun && rerun + 1 < MAX_RERUNS) {
      return runCompile("preview", rerun + 1);
    }
    return out.ok;
  } catch (e) {
    if (seq !== compileSeq) return false;
    store.set({
      compile: { state: "error", ms: null, usedNetwork: false, passes: 0 },
      diagnostics: [{ severity: "error", stage: "latex", message: String(e), file: null, line: null, source: null }],
    });
    return false;
  }
}

export async function refreshTex() {
  const dir = store.get().dir;
  if (!dir) return;
  try {
    store.set({ tex: await api.readTex(dir) });
  } catch {
    store.set({ tex: "% Compile the paper to see the generated LaTeX." });
  }
}

export async function refreshFigures() {
  const dir = store.get().dir;
  if (dir) store.set({ figures: await api.listFigures(dir) });
}
