// Saving and compiling, kept outside React so typing never re-renders the tree.
//
// Edits are written after a short pause, and every save is followed by a preview compile.
// The backend aborts a running compile when a new one starts, so a stale result can only
// arrive out of order; `compileSeq` drops those.
//
// Every backend write (saves and structure commands) goes through one queue, so a structure
// command never races a save of the meta or of a part it rewrites.

import { setWindowTitle } from "@/lib/platform";
import { api, baseName, type CompileMode, type PaperMeta, type Part, type ProjectSnapshot } from "@/lib/api";
import { usesChapters } from "@/lib/templates";
import {
  BIB_FILE,
  PREAMBLE_FILE,
  TEX_FILE,
  initialProjectState,
  isPartFile,
  openFile,
  store,
  useStore,
  type EditorFile,
} from "@/store";
import { rememberProject } from "@/lib/recent";

const SAVE_DELAY_MS = 300;
const COMPILE_DELAY_MS = 150;
/** A new citation needs two passes after BibTeX; one more covers a label added in the same edit. */
const MAX_RERUNS = 3;

/** Parts edited since their last save; their current text is read from the store when written. */
const pendingParts = new Set<string>();
const pendingFields = new Set<"meta" | "bib" | "preamble">();
const PREAMBLE_STARTER = "% Added at the end of the LaTeX preamble: \\usepackage, \\newcommand, ...\n";
/** Text of each part as the backend last stored it. */
let lastSaved = new Map<string, string>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let compileTimer: ReturnType<typeof setTimeout> | undefined;
let compileSeq = 0;
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

function hasPending(): boolean {
  return pendingParts.size > 0 || pendingFields.size > 0;
}

export function loadProject(snapshot: ProjectSnapshot) {
  clearTimeout(saveTimer);
  clearTimeout(compileTimer);
  pendingParts.clear();
  pendingFields.clear();
  lastSaved = new Map(snapshot.parts.map((p) => [p.file, p.content]));
  store.set({
    ...initialProjectState,
    dir: snapshot.dir,
    meta: snapshot.meta,
    parts: snapshot.parts,
    bib: snapshot.bib,
    preamble: snapshot.preamble ?? null,
    figures: snapshot.figures,
    activeFile: snapshot.parts[0]?.file ?? BIB_FILE,
  });
  rememberProject(snapshot.dir, snapshot.meta.title);
  setWindowTitle(`${snapshot.meta.title || baseName(snapshot.dir)} — PaperForge`);
  scheduleCompile("full", 0);
}

export async function closeProject() {
  await flushSaves();
  store.set({ ...initialProjectState });
  setWindowTitle("PaperForge");
}

function queueSave() {
  store.set({ saveState: "pending" });
  clearTimeout(saveTimer);
  clearTimeout(compileTimer);
  saveTimer = setTimeout(() => void flushSaves().then(() => scheduleCompile("preview", COMPILE_DELAY_MS)), SAVE_DELAY_MS);
}

async function writePending() {
  const { dir, parts, meta, bib, preamble } = store.get();
  const files = [...pendingParts];
  const fields = [...pendingFields];
  pendingParts.clear();
  pendingFields.clear();
  if (!dir || (files.length === 0 && fields.length === 0)) return;
  store.set({ saveState: "saving" });
  const contentOf = new Map(parts.map((p) => [p.file, p.content]));
  const errors: string[] = [];
  const writes = files.map(async (file) => {
    const content = contentOf.get(file);
    if (content === undefined) return;
    try {
      await api.savePart(dir, file, content);
      lastSaved.set(file, content);
    } catch (e) {
      pendingParts.add(file);
      errors.push(String(e));
    }
  });
  if (fields.includes("meta") || fields.includes("bib")) {
    const update: { meta?: PaperMeta; bib?: string } = {};
    if (fields.includes("meta") && meta) update.meta = meta;
    if (fields.includes("bib")) update.bib = bib;
    writes.push(
      api.save(dir, update).catch((e) => {
        if (update.meta) pendingFields.add("meta");
        if (update.bib !== undefined) pendingFields.add("bib");
        errors.push(String(e));
      }),
    );
  }
  if (fields.includes("preamble") && preamble !== null) {
    writes.push(
      api.savePreamble(dir, preamble).catch((e) => {
        pendingFields.add("preamble");
        errors.push(String(e));
      }),
    );
  }
  await Promise.all(writes);
  if (store.get().dir !== dir) return;
  store.set({
    saveState: errors.length ? "error" : hasPending() ? "pending" : "saved",
    saveError: errors[0] ?? null,
  });
}

export function flushSaves(): Promise<void> {
  clearTimeout(saveTimer);
  return serial(writePending);
}

export function setPart(file: string, content: string) {
  store.set((s) => ({ parts: s.parts.map((p) => (p.file === file ? { file, content } : p)) }));
  pendingParts.add(file);
  queueSave();
}

export function setBib(bib: string) {
  store.set({ bib });
  pendingFields.add("bib");
  queueSave();
}

export function setPreamble(preamble: string) {
  store.set({ preamble });
  pendingFields.add("preamble");
  queueSave();
}

/** Opens preamble.tex in the editor, creating it first when the project has none. */
export function openPreamble() {
  if (store.get().preamble === null) setPreamble(PREAMBLE_STARTER);
  openFile(PREAMBLE_FILE);
}

export function updateMeta(patch: Partial<PaperMeta>) {
  const meta = store.get().meta;
  if (!meta) return;
  const next = { ...meta, ...patch };
  store.set({ meta: next });
  pendingFields.add("meta");
  queueSave();
  if (patch.title !== undefined) {
    setWindowTitle(`${next.title || "Untitled"} — PaperForge`);
  }
}

// Structure commands -------------------------------------------------------------------------

/**
 * Takes a snapshot from a structure command without resetting the UI. A part edited while the
 * command ran keeps its newer text, unless the command rewrote that part.
 */
function applySnapshot(snapshot: ProjectSnapshot, preferredFile?: EditorFile) {
  const s = store.get();
  const current = new Map(s.parts.map((p) => [p.file, p]));
  const parts: Part[] = snapshot.parts.map((p) => {
    const old = current.get(p.file);
    const untouched = lastSaved.get(p.file) === p.content;
    if (old && pendingParts.has(p.file) && untouched) return old;
    pendingParts.delete(p.file);
    return old && old.content === p.content ? old : p;
  });
  const files = new Set(parts.map((p) => p.file));
  for (const file of [...pendingParts]) if (!files.has(file)) pendingParts.delete(file);
  lastSaved = new Map(snapshot.parts.map((p) => [p.file, p.content]));

  const keep = (file: EditorFile | undefined) => file !== undefined && (!isPartFile(file) || files.has(file));
  const activeFile = keep(preferredFile) ? preferredFile! : keep(s.activeFile) ? s.activeFile : (parts[0]?.file ?? BIB_FILE);
  const { parts: partFiles, templateFile } = snapshot.meta;
  store.set({
    meta: pendingFields.has("meta") && s.meta ? { ...s.meta, parts: partFiles, templateFile } : snapshot.meta,
    parts,
    bib: pendingFields.has("bib") ? s.bib : snapshot.bib,
    preamble: pendingFields.has("preamble") ? s.preamble : (snapshot.preamble ?? null),
    figures: snapshot.figures,
    activeFile,
    addingPart: null,
  });
}

async function restructure(
  command: (dir: string) => Promise<ProjectSnapshot>,
  preferredFile?: (snapshot: ProjectSnapshot) => EditorFile | undefined,
) {
  clearTimeout(saveTimer);
  clearTimeout(compileTimer);
  const snapshot = await serial(async () => {
    await writePending();
    if (pendingParts.size > 0) throw new Error("Your latest edits could not be saved, so the structure was not changed.");
    const dir = store.get().dir;
    return dir ? command(dir) : null;
  });
  if (!snapshot || snapshot.dir !== store.get().dir) return;
  applySnapshot(snapshot, preferredFile?.(snapshot));
  if (hasPending()) queueSave();
  else scheduleCompile("preview", 0);
}

export function createPart(index: number, title: string) {
  return restructure(
    (dir) => api.createPart(dir, index, title),
    (snapshot) => snapshot.parts[index]?.file,
  );
}

export function deletePart(file: string) {
  const { activeFile, parts } = store.get();
  const index = parts.findIndex((p) => p.file === file);
  return restructure(
    (dir) => api.deletePart(dir, file),
    (snapshot) => (activeFile === file ? snapshot.parts[Math.min(index, snapshot.parts.length - 1)]?.file : undefined),
  );
}

export function movePart(file: string, delta: -1 | 1) {
  const order = store.get().parts.map((p) => p.file);
  const from = order.indexOf(file);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return Promise.resolve();
  [order[from], order[to]] = [order[to], order[from]];
  return restructure((dir) => api.reorderParts(dir, order));
}

export function splitPart(file: string, level: 1 | 2) {
  return restructure((dir) => api.splitPart(dir, file, level));
}

/** Merges a part with the one after it, into the first. */
export function mergeWithNext(file: string) {
  const { parts, activeFile } = store.get();
  const index = parts.findIndex((p) => p.file === file);
  const next = parts[index + 1];
  if (index < 0 || !next) return Promise.resolve();
  return restructure(
    (dir) => api.mergeParts(dir, [file, next.file]),
    () => (activeFile === next.file ? file : undefined),
  );
}

export function ejectTemplate() {
  return restructure((dir) => api.ejectTemplate(dir));
}

export function restoreTemplate() {
  return restructure((dir) => api.restoreTemplate(dir));
}

// Compiling ----------------------------------------------------------------------------------

/** The part a preview compiles alone, when "current chapter only" applies. */
function compileFocus(mode: CompileMode): string | null {
  const s = store.get();
  if (mode !== "preview" || !s.previewFocus || !usesChapters(s.meta?.template)) return null;
  return s.parts.some((p) => p.file === s.activeFile) ? s.activeFile : null;
}

export function setPreviewFocus(previewFocus: boolean) {
  localStorage.setItem("paperforge.previewFocus", previewFocus ? "1" : "0");
  store.set({ previewFocus });
  scheduleCompile("preview", 0);
}

// With the focus on, the preview follows the chapter being edited.
useStore.subscribe((s, prev) => {
  if (s.activeFile !== prev.activeFile && s.dir && s.dir === prev.dir && compileFocus("preview") !== null) {
    scheduleCompile("preview", COMPILE_DELAY_MS);
  }
});

export function scheduleCompile(mode: CompileMode, delay: number) {
  clearTimeout(compileTimer);
  compileTimer = setTimeout(() => void runCompile(mode, 0, compileFocus(mode), store.get().reviewMode), delay);
}

/**
 * Saves pending edits and runs a full compile; resolves with whether a fresh PDF exists. `review`
 * defaults to the preview's mode; a compile in the other mode leaves the preview's PDF alone.
 */
export async function compileNow(mode: CompileMode = "full", review = store.get().reviewMode): Promise<boolean> {
  clearTimeout(compileTimer);
  await flushSaves();
  return runCompile(mode, 0, compileFocus(mode), review);
}

/** Shows the review PDF (comments rendered) in the preview, or the final one again. */
export function setReviewMode(reviewMode: boolean) {
  store.set({ reviewMode });
  scheduleCompile("preview", 0);
}

async function runCompile(mode: CompileMode, rerun: number, focus: string | null, review: boolean): Promise<boolean> {
  const dir = store.get().dir;
  if (!dir) return false;
  const seq = ++compileSeq;
  store.set((s) => ({ compile: { ...s.compile, state: "running" } }));
  try {
    const out = await api.compile(dir, mode, focus, review);
    if (seq !== compileSeq || out.cancelled) return false;
    if (out.ok && out.pdfPath && review === store.get().reviewMode) {
      const bytes = new Uint8Array(await api.readBinary(out.pdfPath));
      if (seq !== compileSeq) return false;
      store.set((s) => ({ pdf: { data: bytes, version: (s.pdf?.version ?? 0) + 1 } }));
    }
    store.set((s) => ({
      diagnostics: out.diagnostics,
      toc: out.ok ? (out.toc ?? []) : s.toc,
      labels: out.ok ? (out.labels ?? {}) : s.labels,
      compile: {
        state: out.ok ? "ok" : "error",
        ms: out.pandocMs + out.texMs,
        usedNetwork: out.usedNetwork,
        passes: rerun + 1,
      },
    }));
    if (store.get().activeFile === TEX_FILE) void refreshTex();
    if (out.ok && out.needsRerun && rerun + 1 < MAX_RERUNS) {
      return runCompile("preview", rerun + 1, focus, review);
    }
    return out.ok;
  } catch (e) {
    if (seq !== compileSeq) return false;
    store.set({
      compile: { state: "error", ms: null, usedNetwork: false, passes: 0 },
      diagnostics: [
        { severity: "error", stage: "latex", message: String(e), file: null, line: null, source: null, part: null },
      ],
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
