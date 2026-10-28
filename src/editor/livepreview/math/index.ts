// Equation editor: a click on rendered math in Writing mode, or Mod-Alt-m with the cursor in
// `$…$` / `$$…$$` in either mode, opens a MathLive popover (loaded on first use).

import { EditorView, ViewPlugin, keymap, type Command } from "@codemirror/view";
import { labelRef, useStore } from "@/store";
import { previewDecorations, refreshPreview } from "../index";
import { registerInlineWidget, registerWritingExtension } from "../registry";
import { MathWidget } from "../widgets";
import { openMathEditor, projectMacros, renderMath } from "./popover";
import { mathAt } from "./source";

class EditableMathWidget extends MathWidget {
  constructor(
    tex: string,
    display: boolean,
    tag: string,
    /** The preamble macros it was rendered with. */
    readonly macros: string,
  ) {
    super(tex, display, tag);
  }
  eq(other: EditableMathWidget) {
    return super.eq(other) && other.macros === this.macros;
  }
  render() {
    const dom = super.render();
    if (this.macros) {
      const tag = dom.querySelector(".pf-lp-eqno");
      dom.innerHTML = renderMath(this.tex, this.display);
      if (tag) dom.append(tag);
    }
    dom.title = "Click to edit the equation";
    return dom;
  }
  toDOM(view: EditorView) {
    const dom = this.render();
    dom.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const math = mathAt(view.state, view.posAtDOM(dom));
      if (math) openMathEditor(view, math);
    });
    return dom;
  }
}

registerInlineWidget("math", (token) => {
  const ref = token.label ? labelRef(token.label) : undefined;
  return new EditableMathWidget(token.tex, token.display, ref?.number ? `(${ref.number})` : token.label, projectMacros().signature);
});

/** Re-renders math when the preamble's macros change, or when a part opens after they did. */
registerWritingExtension(
  ViewPlugin.define((view) => {
    let signature = projectMacros().signature;
    let live = true;
    const refresh = () => queueMicrotask(() => live && previewDecorations(view.state) && view.dispatch({ effects: refreshPreview.of(null) }));
    if (signature) refresh();
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (s.preamble === prev.preamble || projectMacros().signature === signature) return;
      signature = projectMacros().signature;
      refresh();
    });
    return {
      destroy() {
        live = false;
        unsubscribe();
      },
    };
  }),
);

export const editMathAtCursor: Command = (view) => {
  const math = mathAt(view.state, view.state.selection.main.head);
  if (!math) return false;
  openMathEditor(view, math);
  return true;
};

export const mathEditorKeymap = keymap.of([{ key: "Mod-Alt-m", run: editMathAtCursor }]);
