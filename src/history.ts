// Version history: autosaves while writing, versions at milestones, compare and restore.
//
// Autosaves are scheduled from successful saves, never from keystrokes: 2 minutes after the
// last save, or at once when typing has gone on for 10 minutes since the last snapshot. Every
// history write goes through the session's write queue. Snapshots taken in the background fail
// quietly; actions the user started throw, and their callers report the error.

import { notify } from "@/components/Toaster";
import { api, type VersionInfo } from "@/lib/api";
import { sessionLabel, versionDate, whenLabel } from "@/lib/history";
import { isGuest } from "@/collab/live";
import { flushSaves, restructure, serial } from "@/session";
import { store, useStore } from "@/store";

const IDLE_MS = 2 * 60_000;
const MAX_INTERVAL_MS = 10 * 60_000;
const PAGE = 50;

let idleTimer: ReturnType<typeof setTimeout> | undefined;
let openedAt = 0;
/** When the last snapshot was taken, or the project opened. */
let lastSnapshot = 0;
/** First and last successful save since the project opened or the last version. */
let session: { start: number; end: number } | null = null;
let refreshSeq = 0;

function enabled(): boolean {
  return store.get().historyStatus?.enabled === true;
}

function currentDir(): string {
  const dir = store.get().dir;
  if (!dir) throw new Error("No project is open.");
  return dir;
}

/** "28 Oct 10:02" for a snapshot in the list, else its short id. */
export function describeSnapshot(id: string): string {
  const version = store.get().versions.find((v) => v.id === id);
  return version ? whenLabel(versionDate(version)) : id.slice(0, 7);
}

/** Resets the schedule for the project just loaded and reads its history. */
export function historyOpened() {
  clearTimeout(idleTimer);
  openedAt = lastSnapshot = Date.now();
  session = null;
  void refreshHistory();
}

/** Edits reached the disk. Timer bookkeeping only: it runs after every save. */
export function noteSaved() {
  const now = Date.now();
  session = { start: session?.start ?? now, end: now };
  clearTimeout(idleTimer);
  if (!enabled()) return;
  if (now - lastSnapshot >= MAX_INTERVAL_MS) void autosave();
  else idleTimer = setTimeout(() => void autosave(), IDLE_MS);
}

/** A structure command changed the files; the backend may have taken an autosave before it. */
export function structureChanged() {
  noteSaved();
  if (enabled()) void refreshHistory();
}

async function autosave() {
  clearTimeout(idleTimer);
  const dir = store.get().dir;
  // The host's window records the shared paper's history.
  if (!dir || !enabled() || isGuest()) return;
  lastSnapshot = Date.now();
  try {
    if (await serial(() => api.historyAutosave(dir))) void refreshHistory(dir);
  } catch {
    // An autosave that fails must not interrupt writing; the next save schedules another.
  }
}

function versionSaved(dir: string) {
  lastSnapshot = Date.now();
  session = null;
  void refreshHistory(dir);
}

/** Reads the status and the newest snapshots, keeping as many as are already shown. */
export async function refreshHistory(dir = store.get().dir) {
  if (!dir) return;
  const seq = ++refreshSeq;
  const current = () => seq === refreshSeq && store.get().dir === dir;
  let status;
  try {
    status = await api.historyStatus(dir);
  } catch {
    if (current()) store.set({ historyStatus: null, versions: [], historyMore: false });
    return;
  }
  if (!status.enabled) {
    if (current()) store.set({ historyStatus: status, versions: [], historyMore: false });
    return;
  }
  const limit = Math.max(PAGE, store.get().versions.length);
  try {
    const versions = await api.historyList(dir, true, null, limit);
    if (current()) store.set({ historyStatus: status, versions, historyMore: versions.length >= limit });
  } catch {
    if (current()) store.set({ historyStatus: status });
  }
}

export async function loadOlderVersions() {
  const dir = currentDir();
  const shown = store.get().versions;
  const last = shown.at(-1);
  if (!last) return;
  const older = await api.historyList(dir, true, last.id, PAGE);
  if (store.get().dir !== dir || store.get().versions !== shown) return;
  store.set({ versions: [...shown, ...older], historyMore: older.length >= PAGE });
}

export async function enableHistory() {
  const dir = currentDir();
  await flushSaves();
  const status = await serial(() => api.historyEnable(dir));
  if (store.get().dir !== dir) return;
  store.set({ historyStatus: status });
  versionSaved(dir);
}

/** The "Save version" action: turns history on first when it is off. */
export async function saveVersion(label: string, note: string) {
  const dir = currentDir();
  if (!enabled()) await enableHistory();
  else await flushSaves();
  const saved = await serial(() => api.historySaveVersion(dir, { label: label || undefined, note: note || undefined }));
  versionSaved(dir);
  notify(saved ? (saved.label ? `Saved version “${saved.label}”` : "Saved a version") : "Nothing changed since the last version");
}

async function automaticVersion(dir: string, reason: string) {
  try {
    if (await serial(() => api.historySaveVersion(dir, { reason }))) versionSaved(dir);
  } catch {
    // Automatic versions are a convenience; the action that asked for one already succeeded.
  }
}

/** After a successful export, so the version sent out can be found again. */
export function versionAfterExport(what: "PDF" | "Review PDF" | "LaTeX") {
  const dir = store.get().dir;
  if (dir && enabled()) void automaticVersion(dir, `${what} exported`);
}

/** Before the project closes: the session becomes a version when the paper changed since the last one. */
export async function versionOnLeave() {
  clearTimeout(idleTimer);
  const dir = store.get().dir;
  if (!dir || !enabled() || isGuest()) return;
  const start = new Date(session?.start ?? openedAt);
  const end = new Date(session?.end ?? Date.now());
  try {
    const status = await api.historyStatus(dir);
    if (status.enabled && status.dirty) await automaticVersion(dir, sessionLabel(start, end));
  } catch {
    // Closing must not fail because history could not be read.
  }
}

export async function labelVersion(version: VersionInfo, label: string | null) {
  const dir = currentDir();
  const updated = await serial(() => api.historyLabel(dir, version.id, label));
  if (store.get().dir !== dir) return;
  store.set((s) => ({ versions: s.versions.map((v) => (v.id === updated.id ? updated : v)) }));
  void refreshHistory(dir);
}

/** Shows what a snapshot changed, against the snapshot before it. */
export async function viewChanges(version: VersionInfo) {
  const dir = currentDir();
  const { versions, historyMore } = store.get();
  let previous: VersionInfo | undefined = versions[versions.findIndex((v) => v.id === version.id) + 1];
  if (!previous && historyMore) [previous] = await api.historyList(dir, true, version.id, 1);
  if (!previous) throw new Error("This is the first version: there is nothing before it to compare with.");
  store.set({ compare: { from: previous.id, to: version.id } });
}

export function compareWithCurrent(version: VersionInfo) {
  store.set({ compare: { from: version.id, to: null } });
}

export function closeCompare() {
  store.set({ compare: null });
}

// The compare view covers the editor: going to a file or a line closes it.
useStore.subscribe((s, prev) => {
  if (s.compare && prev.compare && (s.activeFile !== prev.activeFile || s.jump !== prev.jump)) closeCompare();
});

/** Brings the whole paper back to `version`; the current text is kept as an autosave first. */
export async function restoreVersion(version: VersionInfo) {
  const dir = currentDir();
  await restructure((d) => api.historyRestore(d, version.id));
  if (store.get().dir !== dir) return;
  store.set({ compare: null });
  versionSaved(dir);
  notify(`Restored the version of ${whenLabel(versionDate(version))}`);
}

/** Brings one part back as it was in snapshot `id`, re-inserting it when it was deleted since. */
export async function restorePart(id: string, file: string, title: string) {
  const dir = currentDir();
  await restructure((d) => api.historyRestorePart(d, id, file));
  if (store.get().dir !== dir) return;
  versionSaved(dir);
  notify(`Restored “${title}” from ${describeSnapshot(id)}`);
}
