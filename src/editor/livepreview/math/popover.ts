import type { EditorView } from "@codemirror/view";
import katex from "katex";
import type { MathfieldElement } from "mathlive";
import { store } from "@/store";
import { editedTex, katexMacros, mathAt, mathChange, mathliveMacros, preambleMacros, type MathEdit, type MathSpan, type TexMacro } from "./source";
import "./math.css";

let macroCache: { source: string | null; macros: TexMacro[]; signature: string } = { source: null, macros: [], signature: "" };

/** The macros of the project's preamble.tex, and a string that changes when they do. */
export function projectMacros(): { macros: TexMacro[]; signature: string } {
  const source = store.get().preamble;
  if (source !== macroCache.source) {
    const macros = source ? preambleMacros(source) : [];
    macroCache = { source, macros, signature: macros.length ? JSON.stringify(macros) : "" };
  }
  return macroCache;
}

const htmlCache = new Map<string, string>();

/** KaTeX HTML for `tex`, with the preamble's macros. */
export function renderMath(tex: string, display: boolean): string {
  const { macros, signature } = projectMacros();
  const key = `${display ? "D" : "I"}${signature}\n${tex}`;
  let html = htmlCache.get(key);
  if (html === undefined) {
    html = katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "html", macros: katexMacros(macros) });
    if (htmlCache.size > 500) htmlCache.clear();
    htmlCache.set(key, html);
  }
  return html;
}

let mathlive: Promise<typeof import("mathlive")> | null = null;

function loadMathLive() {
  mathlive ??= import("mathlive").then((module) => {
    const { MathfieldElement } = module;
    // katex.min.css already declares the same KaTeX_* faces (served by Vite); MathLive finds them
    // in document.fonts, and must not fetch from its default "./fonts" next to the chunk.
    MathfieldElement.fontsDirectory = null;
    MathfieldElement.soundsDirectory = null;
    MathfieldElement.keypressSound = null;
    MathfieldElement.plonkSound = null;
    return module;
  });
  mathlive.catch(() => (mathlive = null));
  return mathlive;
}

let open: { close: (apply: boolean) => void } | null = null;

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function place(root: HTMLElement, view: EditorView, math: MathSpan) {
  const start = view.coordsAtPos(math.from, 1);
  const end = view.coordsAtPos(math.to, -1) ?? start;
  const editor = view.dom.getBoundingClientRect();
  const top = start?.top ?? editor.top;
  const bottom = Math.max(end?.bottom ?? top, start?.bottom ?? top);
  const { width, height } = root.getBoundingClientRect();
  const left = Math.min(Math.max(8, start?.left ?? editor.left), window.innerWidth - width - 8);
  const below = bottom + 6 + height <= window.innerHeight - 8;
  root.style.left = `${left}px`;
  root.style.top = `${below ? bottom + 6 : Math.max(8, top - 6 - height)}px`;
}

/**
 * Opens the equation editor on `math`: a MathLive field, the raw LaTeX and a KaTeX preview.
 * Apply writes back only a real edit, as one change of the formula between its delimiters.
 */
export function openMathEditor(view: EditorView, math: MathSpan) {
  open?.close(false);
  const doc = view.state.doc;
  const edit: MathEdit = { original: math.tex, baseline: null, field: null, raw: null };
  let field: MathfieldElement | null = null;
  let closed = false;

  const root = document.createElement("div");
  root.className = "pf-math-editor";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Edit equation");
  const slot = root.appendChild(document.createElement("div"));
  slot.className = "pf-math-editor-field";
  slot.textContent = "Loading equation editor…";
  const raw = root.appendChild(document.createElement("textarea"));
  raw.className = "pf-math-editor-raw";
  raw.setAttribute("aria-label", "LaTeX");
  raw.spellcheck = false;
  raw.rows = math.display ? 3 : 2;
  raw.value = math.tex;
  const preview = root.appendChild(document.createElement("div"));
  preview.className = "pf-math-editor-preview";
  preview.setAttribute("aria-label", "Preview");
  const actions = root.appendChild(document.createElement("div"));
  actions.className = "pf-math-editor-actions";
  actions.append(
    button("Edit as text", "pf-math-editor-text", () => {
      close(false);
      view.dispatch({ selection: { anchor: math.inner.from }, scrollIntoView: true, userEvent: "select" });
    }),
    button("Cancel", "", () => close(false)),
  );
  const apply = actions.appendChild(button("Apply", "pf-math-editor-apply", () => close(true)));

  const shown = () => edit.raw ?? edit.field ?? edit.original;
  const refresh = () => {
    preview.innerHTML = renderMath(shown(), math.display);
    apply.disabled = editedTex(edit) === null || !shown().trim();
  };

  function close(write: boolean) {
    if (closed) return;
    closed = true;
    open = null;
    document.removeEventListener("mousedown", onOutside, true);
    root.remove();
    const tex = write ? editedTex(edit) : null;
    if (tex !== null && tex.trim()) {
      const target = view.state.doc === doc ? math : mathAt(view.state, math.from);
      if (target && target.tex === math.tex) view.dispatch({ changes: mathChange(target, tex), userEvent: "input.math" });
    }
    view.focus();
  }

  function onOutside(e: MouseEvent) {
    const inside = e.composedPath().some((n) => n === root || (n instanceof Element && /\bML__/.test(n.getAttribute("class") ?? "")));
    if (!inside) close(false);
  }

  root.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") close(false);
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) close(true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  raw.addEventListener("input", () => {
    edit.raw = raw.value;
    field?.setValue(raw.value, { silenceNotifications: true });
    refresh();
  });

  document.body.appendChild(root);
  document.addEventListener("mousedown", onOutside, true);
  open = { close };
  refresh();
  place(root, view, math);
  raw.focus();

  loadMathLive().then(
    ({ MathfieldElement }) => {
      if (closed) return;
      const mf = new MathfieldElement();
      mf.mathVirtualKeyboardPolicy = "manual";
      mf.setAttribute("aria-label", "Equation");
      slot.replaceChildren(mf);
      mf.macros = { ...mf.macros, ...mathliveMacros(projectMacros().macros) };
      mf.setValue(edit.original, { silenceNotifications: true });
      edit.baseline = edit.field = mf.getValue("latex");
      if (edit.raw !== null) mf.setValue(edit.raw, { silenceNotifications: true });
      mf.addEventListener("input", () => {
        edit.field = mf.getValue("latex");
        edit.raw = null;
        raw.value = edit.field;
        refresh();
      });
      field = mf;
      place(root, view, math);
      if (document.activeElement === raw && edit.raw === null) mf.focus();
    },
    (e) => {
      if (!closed) slot.textContent = `The equation editor could not load: ${e}`;
    },
  );
}
