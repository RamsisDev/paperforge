// A bibliography another program keeps exporting (Zotero with Better BibTeX "keep updated") can be
// linked to the project. Its entries are merged into refs.bib, so compiling never depends on it.

import { notify } from "@/components/Toaster";
import { api } from "@/lib/api";
import { mergeBib } from "@/lib/bib";
import { isDesktop } from "@/lib/platform";
import { setBib } from "@/session";
import { store, useStore } from "@/store";

export interface ZoteroSync {
  added: string[];
  updated: string[];
}

/** Merges the linked file into refs.bib; null when the project has no link. */
export async function syncZotero(): Promise<ZoteroSync | null> {
  const dir = store.get().dir;
  if (!dir) return null;
  const linked = await api.zoteroRead(dir);
  if (linked === null || store.get().dir !== dir) return null;
  const merged = mergeBib(store.get().bib, linked);
  if (merged.added.length > 0 || merged.updated.length > 0) setBib(merged.bib);
  return { added: merged.added, updated: merged.updated };
}

export function describeSync(sync: ZoteroSync): string {
  const parts = [
    sync.added.length > 0 && `${sync.added.length} added`,
    sync.updated.length > 0 && `${sync.updated.length} updated`,
  ].filter(Boolean);
  return parts.length > 0 ? `Zotero: ${parts.join(", ")}` : "refs.bib is up to date with Zotero";
}

async function autoSync() {
  try {
    const sync = await syncZotero();
    if (sync && (sync.added.length > 0 || sync.updated.length > 0)) notify(describeSync(sync));
  } catch (e) {
    notify(`Zotero sync failed: ${String(e)}`, "error");
  }
}

let listening: Promise<unknown> | null = null;
let debounce: ReturnType<typeof setTimeout> | undefined;

/** (Re)starts the desktop watcher on the project's link; resolves with whether it watches. */
export async function watchZotero(dir: string): Promise<boolean> {
  if (!isDesktop || !(await api.zoteroWatch(dir))) return false;
  listening ??= import("@tauri-apps/api/event").then(({ listen }) =>
    listen<string>("zotero-changed", (event) => {
      if (event.payload !== store.get().dir) return;
      clearTimeout(debounce);
      // Exporters often write a file in several steps.
      debounce = setTimeout(() => void autoSync(), 500);
    }),
  );
  return true;
}

// Opening a project starts its watcher and catches up with changes made while it was closed.
useStore.subscribe((s, prev) => {
  if (!s.dir || s.dir === prev.dir) return;
  void watchZotero(s.dir)
    .then((watching) => (watching ? autoSync() : undefined))
    .catch((e) => notify(`Zotero link: ${String(e)}`, "error"));
});
