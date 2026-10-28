import { setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { editorBridge } from "@/editor/bridge";
import { bibExtensions, flashLine, markdownExtensions, texExtensions } from "@/editor/extensions";
import { locate } from "@/lib/diagnostics";
import { setBib, setPart } from "@/session";
import { BIB_FILE, TEX_FILE, store, useStore, type EditorFile } from "@/store";

type Contents = Map<EditorFile, string>;

function contents(s: ReturnType<typeof store.get>): Contents {
  const map: Contents = new Map(s.parts.map((p) => [p.file, p.content]));
  map.set(BIB_FILE, s.bib);
  map.set(TEX_FILE, s.tex);
  return map;
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
  const dir = useStore((s) => s.dir);
  const activeFile = useStore((s) => s.activeFile);

  function createState(file: EditorFile): EditorState {
    const onChange = EditorView.updateListener.of((u) => {
      if (u.docChanged && !applyingExternal.current) {
        const text = u.state.doc.toString();
        emitted.current.set(file, text);
        if (file === BIB_FILE) setBib(text);
        else if (file !== TEX_FILE) setPart(file, text);
      }
      if (u.selectionSet || u.docChanged) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        store.set({ cursor: { line: line.number, col: head - line.from + 1 } });
      }
    });
    const extensions =
      file === BIB_FILE ? bibExtensions(onChange) : file === TEX_FILE ? texExtensions() : markdownExtensions(onChange);
    return EditorState.create({ doc: contents(store.get()).get(file) ?? "", extensions });
  }

  // One view per project; documents swap underneath it.
  useEffect(() => {
    if (!host.current) return;
    states.current = new Map();
    scroll.current = new Map();
    emitted.current = new Map();
    const file = store.get().activeFile;
    current.current = file;
    const view = new EditorView({ state: createState(file), parent: host.current });
    viewRef.current = view;
    editorBridge.view = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
      editorBridge.view = null;
    };
  }, [dir]);

  // Switch files, keeping each file's undo history and scroll position.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || current.current === activeFile) return;
    if (contents(store.get()).has(current.current)) {
      states.current.set(current.current, view.state);
      scroll.current.set(current.current, view.scrollDOM.scrollTop);
    }
    let next = states.current.get(activeFile);
    if (!next || (activeFile === TEX_FILE && next.doc.toString() !== store.get().tex)) {
      next = createState(activeFile);
    }
    view.setState(next);
    current.current = activeFile;
    requestAnimationFrame(() => (view.scrollDOM.scrollTop = scroll.current.get(activeFile) ?? 0));
    applyLint();
  }, [activeFile]);

  // Content changed outside the editor: a structure command reloaded parts, the sidebar
  // inserted a bib entry, paper.tex was regenerated.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        const view = viewRef.current;
        if (!view || (s.parts === prev.parts && s.bib === prev.bib && s.tex === prev.tex)) return;
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
