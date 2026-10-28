import type { Extension } from "@codemirror/state";
import { Decoration, MatchDecorator, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";

function marks(regexp: RegExp, className: string): Extension {
  const decorator = new MatchDecorator({ regexp, decoration: Decoration.mark({ class: className }) });
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
      }
      update(u: ViewUpdate) {
        this.decorations = decorator.updateDeco(u, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** The generated tab's highlighting: commands and inline math. */
export const latexHighlight: Extension = [marks(/\\[a-zA-Z@]+/g, "pf-attr"), marks(/\$[^$\n]+\$/g, "pf-math")];
