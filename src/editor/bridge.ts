import type { EditorView } from "@codemirror/view";

/** The live editor view, for toolbar and sidebar actions outside the editor component. */
export const editorBridge: { view: EditorView | null } = { view: null };

export function withEditor(action: (view: EditorView) => unknown) {
  const view = editorBridge.view;
  if (view && !view.state.readOnly) action(view);
}
