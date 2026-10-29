// The texts of a shared session, as the session code and the editor see them. Parts and refs.bib
// are Yjs texts while a session runs: the host's backend writes them to disk, so nothing here
// saves them, and every change, local or remote, reaches the store through the text.

import { ChangeSet, type ChangeSpec } from "@codemirror/state";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { PREAMBLE_FILE, TEX_FILE, store, type EditorFile } from "@/store";

export interface SharedText {
  text: Y.Text;
  awareness: Awareness;
  /** Outlives editor states, so undo keeps working after switching files. */
  undo: Y.UndoManager;
  /** The host's text has arrived; until then the file is read-only. */
  synced: boolean;
}

export const live = {
  texts: new Map<EditorFile, SharedText>(),
  /** Ends the session as the project closes: the host stops sharing, a guest disconnects. */
  leave: null as (() => Promise<void>) | null,
};

/** Parts and refs.bib are shared while a session runs; preamble.tex and paper.tex are not. */
export function isShared(file: EditorFile): boolean {
  return store.get().collab !== null && file !== TEX_FILE && file !== PREAMBLE_FILE && file !== "";
}

export function isGuest(): boolean {
  return store.get().collab?.role === "guest";
}

/** The shared text of `file`, once it holds the host's text. */
export function sharedText(file: EditorFile): SharedText | undefined {
  const shared = live.texts.get(file);
  return shared?.synced ? shared : undefined;
}

export function sharedContent(file: EditorFile): string | undefined {
  return sharedText(file)?.text.toString();
}

/**
 * Applies `changes` (positions in the current text) to a shared file; false when it is not
 * shared. Changes to a file still syncing are dropped: its editor is read-only meanwhile.
 */
export function editShared(file: EditorFile, changes: ChangeSpec): boolean {
  if (!isShared(file)) return false;
  const shared = sharedText(file);
  if (!shared) return true;
  const set = ChangeSet.of(changes, shared.text.length);
  const edits: { from: number; to: number; insert: string }[] = [];
  set.iterChanges((from, to, _fromB, _toB, inserted) => edits.push({ from, to, insert: inserted.toString() }));
  if (edits.length === 0) return true;
  shared.text.doc!.transact(() => {
    for (const { from, to, insert } of edits.reverse()) {
      if (to > from) shared.text.delete(from, to - from);
      if (insert) shared.text.insert(from, insert);
    }
  });
  return true;
}

/** Turns a shared file's text into `content` by replacing only the span that differs. */
export function replaceShared(file: EditorFile, content: string): boolean {
  const current = sharedContent(file);
  if (current === undefined || current === content) return isShared(file);
  let start = 0;
  const max = Math.min(current.length, content.length);
  while (start < max && current.charCodeAt(start) === content.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < max - start &&
    current.charCodeAt(current.length - 1 - end) === content.charCodeAt(content.length - 1 - end)
  ) {
    end++;
  }
  return editShared(file, { from: start, to: current.length - end, insert: content.slice(start, content.length - end) });
}
