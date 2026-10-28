import type { ChangeSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** The live editor view, for toolbar and sidebar actions outside the editor component. */
export const editorBridge: {
  view: EditorView | null;
  /**
   * Applies `changes` to any part or the bibliography as one editor transaction, so the file
   * keeps its undo history and the edit is saved. Offsets refer to the file's current text.
   */
  edit: ((file: string, changes: ChangeSpec) => void) | null;
} = { view: null, edit: null };

export function withEditor(action: (view: EditorView) => unknown) {
  const view = editorBridge.view;
  if (view && !view.state.readOnly) action(view);
}
