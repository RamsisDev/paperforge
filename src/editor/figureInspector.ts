import { StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip, type TooltipView } from "@codemirror/view";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { FigureInspector, type FigureEdit } from "@/components/FigureInspector";
import { untracked } from "@/editor/changes/track";
import { notify } from "@/components/Toaster";
import { figureLabels, pasteFigures } from "@/components/sidebar/FiguresPanel";
import { FIGURE_EXTENSIONS, figureFileName, parseFigure, type Figure } from "./figureSyntax";

function figureOnLine(state: EditorState, lineStart: number): Figure | null {
  if (lineStart > state.doc.length) return null;
  const line = state.doc.lineAt(lineStart);
  return line.text.includes("![") ? parseFigure(line.text, line.from) : null;
}

function inspectorView(view: EditorView, lineStart: number): TooltipView {
  const dom = document.createElement("div");
  const root = createRoot(dom);
  const apply = (edit: FigureEdit) => {
    const fig = figureOnLine(view.state, lineStart);
    const changes = fig ? edit(fig) : [];
    if (changes.length) view.dispatch({ changes, userEvent: "input.figure", annotations: untracked.of(true) });
  };
  const render = () => {
    const figure = figureOnLine(view.state, lineStart);
    if (figure) root.render(createElement(FigureInspector, { figure, apply, takenLabels: figureLabels, onDone: () => view.focus() }));
  };
  render();
  return {
    dom,
    // Under the whole (wrapped) line, aligned with its start.
    getCoords(pos) {
      const start = view.coordsAtPos(pos, 1);
      const end = view.coordsAtPos(view.state.doc.lineAt(pos).to, -1) ?? start;
      return start && end ? { left: start.left, right: start.left, top: end.top, bottom: end.bottom } : new DOMRect();
    },
    update: (u) => u.docChanged && render(),
    // Unmounting synchronously inside a React event handler that dispatched would warn.
    destroy: () => queueMicrotask(() => root.unmount()),
  };
}

/** The same tooltip while the cursor stays on the same figure line, so the inspector keeps its state. */
const figureTooltip = StateField.define<Tooltip | null>({
  create: () => null,
  update(tooltip, tr) {
    if (!tr.docChanged && !tr.selection) return tooltip;
    const line = tr.state.doc.lineAt(tr.state.selection.main.head);
    if (!figureOnLine(tr.state, line.from)) return null;
    if (tooltip?.pos === line.from) return tooltip;
    return { pos: line.from, create: (view) => inspectorView(view, line.from) };
  },
  provide: (f) => showTooltip.from(f),
});

/** Clipboard text that only names the pasted files (a copy in the file manager) does not count. */
function onlyNames(text: string, files: File[]): boolean {
  const names = new Set(files.map((f) => f.name));
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .every((l) => names.has(l.trim().split(/[\\/]/).pop() ?? ""));
}

const pasteImages = EditorView.domEventHandlers({
  paste(event, view) {
    const data = event.clipboardData;
    const files = data ? [...data.files] : [];
    if (!data || files.length === 0) return false;
    const text = data.getData("text/plain");
    if (text.trim() && !onlyNames(text, files)) return false;
    event.preventDefault();
    const accepted: { file: File; name: string }[] = [];
    for (const file of files) {
      const name = figureFileName(file.name, file.type);
      if (name) accepted.push({ file, name });
      else notify(`Cannot use ${file.name || file.type || "this file"} as a figure: use ${FIGURE_EXTENSIONS.join(", ")}`, "error");
    }
    if (accepted.length) void pasteFigures(view, accepted).catch((e) => notify(String(e), "error"));
    return true;
  },
});

export function figureTools(): Extension {
  return [figureTooltip, pasteImages];
}
