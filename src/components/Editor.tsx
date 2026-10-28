import { isolateHistory } from "@codemirror/commands";
import { setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { EditorSelection, EditorState, type ChangeSpec, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { editorBridge } from "@/editor/bridge";
import {
  bibExtensions,
  flashLine,
  latexSourceExtensions,
  markdownExtensions,
  syncChapterTemplate,
  texExtensions,
} from "@/editor/extensions";
import { syncEditorMode } from "@/editor/livepreview";
import { generatedLine } from "@/editor/livepreview/showlatex";
import type { SourceSpot } from "@/lib/api";
import { locate } from "@/lib/diagnostics";
import { setBib, setPart, setPreamble } from "@/session";
import { BIB_FILE, PREAMBLE_FILE, TEX_FILE, isPartFile, openFind, store, useStore, type EditorFile } from "@/store";

type Contents = Map<EditorFile, string>;

function contents(s: ReturnType<typeof store.get>): Contents {
  const map: Contents = new Map(s.parts.map((p) => [p.file, p.content]));
  map.set(BIB_FILE, s.bib);
  map.set(TEX_FILE, s.tex);
  if (s.preamble !== null) map.set(PREAMBLE_FILE, s.preamble);
  return map;
}

function storeText(file: EditorFile, text: string) {
  if (file === BIB_FILE) setBib(text);
  else if (file === PREAMBLE_FILE) setPreamble(text);
  else if (file !== TEX_FILE) setPart(file, text);
}

function extensionsFor(file: EditorFile, onChange: Extension) {
  if (file === BIB_FILE) return bibExtensions(onChange);
  if (file === TEX_FILE) return texExtensions();
  if (file === PREAMBLE_FILE) return latexSourceExtensions(onChange);
  return markdownExtensions(onChange);
}

export function Editor() {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const states = useRef(new Map<EditorFile, EditorState>());
  const scroll = useRef(new Map<EditorFile, number>());
  const current = useRef<EditorFile>("");
  /** Text this editor last wrote to the store, so its own echoes are not re-applied. */
  const emitted = useRef(new Map<EditorFile, string>());
  /** Set while a change from outside the editor is applied, so it is not saved back. */
  const applyingExternal = useRef(false);
  /** The Markdown cursor the generated LaTeX follows: the last part's, when the tab was left. */
  const markdownSpot = useRef<SourceSpot | null>(null);
  const dir = useStore((s) => s.dir);
  const activeFile = useStore((s) => s.activeFile);

  function createState(file: EditorFile): EditorState {
    const onChange = EditorView.updateListener.of((u) => {
      if (u.docChanged && !applyingExternal.current) {
        const text = u.state.doc.toString();
        emitted.current.set(file, text);
        storeText(file, text);
      }
      if (u.selectionSet || u.docChanged) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        store.set({ cursor: { line: line.number, col: head - line.from + 1 } });
      }
    });
    return EditorState.create({ doc: contents(store.get()).get(file) ?? "", extensions: extensionsFor(file, onChange) });
  }

  /** Edits a file through its own state, so Mod-Z in that file undoes the edit. */
  function edit(file: EditorFile, changes: ChangeSpec) {
    const text = contents(store.get()).get(file);
    if (text === undefined || file === TEX_FILE) return;
    const spec: TransactionSpec = { changes, userEvent: "input.replace", annotations: isolateHistory.of("full") };
    const view = viewRef.current;
    if (view && file === current.current) {
      view.dispatch(spec);
      return;
    }
    let state = states.current.get(file);
    if (!state || state.doc.toString() !== text) state = createState(file);
    const next = state.update(spec).state;
    states.current.set(file, next);
    const value = next.doc.toString();
    emitted.current.set(file, value);
    storeText(file, value);
  }

  // One view per project; documents swap underneath it.
  useEffect(() => {
    if (!host.current) return;
    states.current = new Map();
    scroll.current = new Map();
    emitted.current = new Map();
    markdownSpot.current = null;
    const file = store.get().activeFile;
    current.current = file;
    const view = new EditorView({ state: createState(file), parent: host.current });
    viewRef.current = view;
    editorBridge.view = view;
    editorBridge.edit = edit;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
      editorBridge.view = null;
      editorBridge.edit = null;
    };
  }, [dir]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== "f") return;
      e.preventDefault();
      const state = viewRef.current?.state;
      const selected = state?.sliceDoc(state.selection.main.from, state.selection.main.to);
      openFind(selected && !selected.includes("\n") ? selected : undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Switch files, keeping each file's undo history and scroll position.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || current.current === activeFile) return;
    if (contents(store.get()).has(current.current)) {
      states.current.set(current.current, view.state);
      scroll.current.set(current.current, view.scrollDOM.scrollTop);
      if (isPartFile(current.current)) {
        markdownSpot.current = { part: current.current, line: view.state.doc.lineAt(view.state.selection.main.head).number };
      }
    }
    let next = states.current.get(activeFile);
    if (!next || (activeFile === TEX_FILE && next.doc.toString() !== store.get().tex)) {
      next = createState(activeFile);
    }
    view.setState(next);
    syncChapterTemplate(view);
    syncEditorMode(view);
    current.current = activeFile;
    requestAnimationFrame(() => {
      if (activeFile !== TEX_FILE || !followMarkdown()) view.scrollDOM.scrollTop = scroll.current.get(activeFile) ?? 0;
    });
    applyLint();
  }, [activeFile]);

  /** Scrolls the generated LaTeX to the block of the Markdown cursor; false when it is not there. */
  function followMarkdown(): boolean {
    const view = viewRef.current;
    const spot = markdownSpot.current;
    if (!view || !spot || current.current !== TEX_FILE) return false;
    const target = generatedLine(view.state.doc, spot.part, spot.line);
    if (!target) return false;
    const doc = view.state.doc;
    const line = doc.line(target.line);
    view.dispatch({
      selection: EditorSelection.cursor(line.from),
      effects: [EditorView.scrollIntoView(doc.line(target.marker).from, { y: "start", yMargin: 48 }), flashLine.of(line.from)],
    });
    setTimeout(() => viewRef.current?.dispatch({ effects: flashLine.of(null) }), 1300);
    return true;
  }

  // Content changed outside the editor: a structure command reloaded parts, the sidebar
  // inserted a bib entry, paper.tex was regenerated.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        const view = viewRef.current;
        const unchanged = s.parts === prev.parts && s.bib === prev.bib && s.tex === prev.tex && s.preamble === prev.preamble;
        if (!view || unchanged) return;
        const now = contents(s);
        const before = contents(prev);
        for (const file of before.keys()) if (!now.has(file)) states.current.delete(file);
        for (const [file, value] of now) {
          if (value === before.get(file) || value === emitted.current.get(file)) continue;
          emitted.current.delete(file);
          if (file !== current.current) {
            states.current.delete(file);
          } else if (view.state.doc.toString() !== value) {
            applyingExternal.current = true;
            try {
              view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
            } finally {
              applyingExternal.current = false;
            }
            if (file === TEX_FILE) followMarkdown();
          }
        }
      }),
    [],
  );

  function applyLint() {
    const view = viewRef.current;
    if (!view) return;
    const { diagnostics, parts } = store.get();
    const file = current.current;
    const doc = view.state.doc;
    const marks: CmDiagnostic[] = [];
    for (const d of locate(diagnostics, parts)) {
      if (d.file !== file || d.line === null || d.line >= doc.lines) continue;
      const line = doc.line(d.line + 1);
      marks.push({
        from: line.from,
        to: line.to,
        severity: d.diagnostic.severity,
        source: d.diagnostic.stage,
        message: d.diagnostic.message,
      });
    }
    view.dispatch(setDiagnostics(view.state, marks));
  }

  useEffect(() => useStore.subscribe((s, prev) => s.diagnostics !== prev.diagnostics && applyLint()), []);

  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.meta?.template !== prev.meta?.template && viewRef.current) syncChapterTemplate(viewRef.current);
        if (s.editorMode !== prev.editorMode && viewRef.current) syncEditorMode(viewRef.current);
      }),
    [],
  );

  // Jump requests from the structure tab, problems panel and the PDF preview.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        const jump = s.jump;
        const view = viewRef.current;
        if (!jump || jump === prev.jump || !view) return;
        requestAnimationFrame(() => {
          if (current.current !== jump.file) return;
          const doc = view.state.doc;
          if (jump.select) {
            const to = Math.min(jump.select.to, doc.length);
            const from = Math.min(jump.select.from, to);
            view.dispatch({
              selection: EditorSelection.range(from, to),
              effects: EditorView.scrollIntoView(from, { y: "center" }),
            });
            view.focus();
            return;
          }
          const line = doc.line(Math.min(Math.max(jump.line + 1, 1), doc.lines));
          view.dispatch({
            selection: EditorSelection.cursor(line.from),
            effects: [EditorView.scrollIntoView(line.from, { y: "center" }), flashLine.of(line.from)],
          });
          view.focus();
          setTimeout(() => viewRef.current?.dispatch({ effects: flashLine.of(null) }), 1300);
        });
      }),
    [],
  );

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
