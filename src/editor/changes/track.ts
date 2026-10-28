// Track changes as a transaction filter: while tracking is on, a typed, pasted or deleted run of
// text inside one line of prose is replaced by the transaction that records it (`trackEdit`), so
// undo takes back the edit and its markup together. Everything else goes through as made: edits
// marked `untracked` (find/replace, table grid, equation editor, figure inspector, accept/reject),
// undo/redo, formatting commands, line breaks, several cursors, and edits inside code, math,
// attributes, raw LaTeX, link targets or div fences.

import { syntaxTree } from "@codemirror/language";
import { Annotation, EditorState, Transaction, type Extension } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { divFence } from "@/editor/livepreview/syntax";
import { trackEdit, type ChangeFields, type EditKind, type TrackedEdit } from "./model";

/** Marks a transaction that must never be recorded as a tracked change. */
export const untracked = Annotation.define<boolean>();

/** Lines searched for the blank line that bounds a paragraph. */
const PARAGRAPH_LINES = 200;

const isBlank = (text: string) => /^\s*$/.test(text);

/** `from`..`to` grown to the paragraphs around it, the reach of a review span. */
export function paragraphsAround(state: EditorState, from: number, to: number): { from: number; to: number } {
  const doc = state.doc;
  let first = doc.lineAt(from);
  for (let n = 0; n < PARAGRAPH_LINES && first.number > 1 && !isBlank(first.text); n++) first = doc.line(first.number - 1);
  let last = doc.lineAt(to);
  for (let n = 0; n < PARAGRAPH_LINES && last.number < doc.lines && !isBlank(last.text); n++) last = doc.line(last.number + 1);
  return { from: first.from, to: last.to };
}

/** Syntax nodes whose text is not prose. */
const OPAQUE = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "HTMLBlock",
  "HTMLTag",
  "CommentBlock",
  "Comment",
  "ProcessingInstructionBlock",
  "URL",
  "LinkTitle",
  "LinkLabel",
  "Autolink",
  "Image",
]);

function opaqueAt(state: EditorState, pos: number): boolean {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (OPAQUE.has(node.name) && node.from < pos && pos < node.to) return true;
    }
  }
  return false;
}

function editKind(tr: Transaction): EditKind | null {
  if (tr.isUserEvent("input.type.compose")) return null;
  if (tr.isUserEvent("input.type") || tr.isUserEvent("input.paste")) return "type";
  if (tr.isUserEvent("delete.backward")) return "backward";
  if (tr.isUserEvent("delete.forward")) return "forward";
  if (tr.isUserEvent("delete.selection") || tr.isUserEvent("delete.cut")) return "selection";
  return null;
}

/** The one edit `tr` makes, or null when it makes several. */
function singleEdit(tr: Transaction): Omit<TrackedEdit, "kind"> | null {
  let edit: Omit<TrackedEdit, "kind"> | null = null;
  let count = 0;
  tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
    count++;
    const insert = inserted.toString();
    const head = tr.selection?.main.head ?? fromB + insert.length;
    edit = { from: fromA, to: toA, insert, caret: Math.max(0, Math.min(insert.length, head - fromB)) };
  });
  return count === 1 ? edit : null;
}

export interface TrackingOptions {
  /** Who and when to sign changes with, or null while tracking is off. */
  settings: () => ChangeFields | null;
  /** Called when an edit was dropped because it cut through review markup. */
  onBlocked?: () => void;
}

export function trackingFilter({ settings, onBlocked }: TrackingOptions): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.annotation(untracked) || tr.startState.selection.ranges.length > 1) return tr;
    const made = singleEdit(tr);
    const kind = made && editKind(tr);
    const fields = kind && settings();
    if (!made || !kind || !fields) return tr;
    const edit: TrackedEdit = { ...made, kind };
    const state = tr.startState;
    const line = state.doc.lineAt(edit.from);
    if (divFence(line.text) || opaqueAt(state, edit.from) || (edit.to > edit.from && opaqueAt(state, edit.to))) return tr;
    const range = paragraphsAround(state, edit.from, edit.to);
    const result = trackEdit(edit, { ...fields, text: state.sliceDoc(range.from, range.to), base: range.from });
    if (result === "untracked") return tr;
    if (result === "blocked") {
      onBlocked?.();
      return {};
    }
    return {
      changes: result.changes,
      selection: { anchor: result.cursor },
      effects: tr.effects,
      scrollIntoView: tr.scrollIntoView,
      userEvent: tr.annotation(Transaction.userEvent),
    };
  });
}
