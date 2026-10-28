// "Show LaTeX": a popover with the generated LaTeX of the cursor's top-level block (Mod-Alt-L or
// the "TeX" handle at the end of the cursor's line), in Source and Writing mode, and the
// generated tab's double-click back to the Markdown.

import { isolateHistory } from "@codemirror/commands";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, showTooltip, type Tooltip, type TooltipView, type ViewUpdate } from "@codemirror/view";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { MOD, isMac } from "@/components/ui";
import { api, type BlockLatex } from "@/lib/api";
import { isPartFile, jumpTo, store } from "@/store";
import { generatedSpot, rawLatexChange } from "./model";
import { ShowLatexPanel, type Lookup } from "./Panel";

export { generatedLine, generatedSpot, rawLatexChange } from "./model";

interface Popover {
  line: number;
  lookup: Lookup;
  tooltip: Tooltip;
}

const openPopover = StateEffect.define<{ pos: number; line: number }>();
const setLookup = StateEffect.define<Lookup>();
const closePopover = StateEffect.define<null>();

/** Open until closed or the document changes, since the lines it shows would no longer match. */
const popoverField = StateField.define<Popover | null>({
  create: () => null,
  update(value, tr) {
    if (value && tr.docChanged) value = null;
    for (const e of tr.effects) {
      if (e.is(openPopover)) {
        value = { line: e.value.line, lookup: { status: "loading" }, tooltip: { pos: e.value.pos, create: panelView } };
      } else if (e.is(setLookup) && value) {
        value = { ...value, lookup: e.value };
      } else if (e.is(closePopover)) {
        value = null;
      }
    }
    return value;
  },
  provide: (f) => showTooltip.from(f, (v) => v?.tooltip ?? null),
});

function panelView(view: EditorView): TooltipView {
  const dom = document.createElement("div");
  const root = createRoot(dom);
  const close = () => {
    view.dispatch({ effects: closePopover.of(null) });
    view.focus();
  };
  const convert = (block: BlockLatex) => {
    view.dispatch({
      changes: rawLatexChange(view.state.doc, block),
      userEvent: "input.convert",
      annotations: isolateHistory.of("full"),
    });
    view.focus();
  };
  let shown: Lookup | null = null;
  const render = () => {
    const lookup = view.state.field(popoverField, false)?.lookup;
    if (!lookup || lookup === shown) return;
    shown = lookup;
    root.render(createElement(ShowLatexPanel, { lookup, onConvert: convert, onClose: close }));
  };
  render();
  return { dom, update: render, destroy: () => queueMicrotask(() => root.unmount()) };
}

/** Opens the popover for the cursor's block of the open part. */
export function showLatexAtCursor(view: EditorView): boolean {
  const { dir, activeFile } = store.get();
  if (!dir || !isPartFile(activeFile) || view.state.field(popoverField, false) === undefined) return false;
  const doc = view.state.doc;
  const line = doc.lineAt(view.state.selection.main.head);
  view.dispatch({ effects: openPopover.of({ pos: line.from, line: line.number }) });
  const answer = (lookup: Lookup) => {
    if (view.state.doc === doc && view.state.field(popoverField, false)?.line === line.number) {
      view.dispatch({ effects: setLookup.of(lookup) });
    }
  };
  api.blockLatex(dir, activeFile, line.number, doc.toString()).then(
    (block) => answer(block ? { status: "ok", block } : { status: "none" }),
    (e) => answer({ status: "error", message: String(e) }),
  );
  return true;
}

function closeShowLatex(view: EditorView): boolean {
  if (!view.state.field(popoverField, false)) return false;
  view.dispatch({ effects: closePopover.of(null) });
  return true;
}

/** A small "TeX" button in the right padding of the cursor's line. */
const handle = ViewPlugin.fromClass(
  class {
    readonly dom: HTMLButtonElement;

    constructor(readonly view: EditorView) {
      const dom = (this.dom = document.createElement("button"));
      dom.type = "button";
      dom.className = "pf-showlatex-handle";
      dom.textContent = "TeX";
      dom.title = `Show the LaTeX of this block (${MOD}${isMac ? "⌥" : "Alt+"}L)`;
      dom.setAttribute("aria-label", "Show LaTeX");
      dom.addEventListener("mousedown", (e) => e.preventDefault());
      dom.addEventListener("click", () => showLatexAtCursor(view));
      view.scrollDOM.appendChild(dom);
      this.place();
    }

    update(u: ViewUpdate) {
      if (u.selectionSet || u.docChanged || u.geometryChanged || u.viewportChanged) this.place();
    }

    place() {
      this.view.requestMeasure({
        key: this,
        read: (view) => {
          const scroller = view.scrollDOM.getBoundingClientRect();
          const content = view.contentDOM.getBoundingClientRect();
          const line = view.lineBlockAt(view.state.selection.main.head);
          return {
            top: view.documentTop - scroller.top + view.scrollDOM.scrollTop + line.top,
            left: content.right - scroller.left + view.scrollDOM.scrollLeft,
          };
        },
        write: ({ top, left }) => {
          this.dom.style.top = `${top}px`;
          this.dom.style.left = `${left - 22}px`;
        },
      });
    }

    destroy() {
      this.dom.remove();
    }
  },
);

const theme = EditorView.baseTheme({
  ".pf-showlatex-handle": {
    position: "absolute",
    zIndex: "5",
    height: "14px",
    marginTop: "4px",
    padding: "0 2px",
    border: "1px solid var(--pf-line)",
    borderRadius: "4px",
    background: "var(--pf-panel)",
    color: "var(--pf-faint)",
    font: "600 8px/12px var(--font-sans)",
    opacity: "0.6",
    cursor: "default",
  },
  ".pf-showlatex-handle:hover": { opacity: "1", color: "var(--pf-accent)", borderColor: "var(--pf-accent)" },
  ".pf-showlatex-code .cm-editor": { fontSize: "12px" },
  ".pf-showlatex-code .cm-content": { padding: "4px 0 !important", maxWidth: "none !important" },
  ".pf-showlatex-code .cm-line": { padding: "0 8px !important" },
});

/** The popover, its shortcut and the handle, for Markdown parts. */
export const showLatex: Extension = [
  popoverField,
  keymap.of([
    { key: "Mod-Alt-l", run: showLatexAtCursor },
    { key: "Escape", run: closeShowLatex },
  ]),
  handle,
  theme,
];

/** In the generated tab, a double-click opens the Markdown line a LaTeX line came from. */
export const generatedNavigation: Extension = EditorView.domEventHandlers({
  dblclick(event, view) {
    const pos = view.posAtCoords(event);
    if (pos === null) return false;
    const spot = generatedSpot(view.state.doc, view.state.doc.lineAt(pos).number);
    if (!spot || !store.get().parts.some((p) => p.file === spot.part)) return false;
    event.preventDefault();
    jumpTo(spot.part, spot.line - 1);
    return true;
  },
});
