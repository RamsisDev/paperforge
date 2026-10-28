import { setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { editorBridge } from "@/editor/bridge";
import { bibExtensions, flashLine, markdownExtensions, texExtensions } from "@/editor/extensions";
import { locate } from "@/lib/diagnostics";
import { setBib, setBody } from "@/session";
import { store, useStore, type EditorFile } from "@/store";

const FILES: EditorFile[] = ["paper.md", "refs.bib", "paper.tex"];

function contentOf(file: EditorFile): string {
  const s = store.get();
  return file === "paper.md" ? s.body : file === "refs.bib" ? s.bib : s.tex;
}

export function Editor() {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const states = useRef(new Map<EditorFile, EditorState>());
  const scroll = useRef(new Map<EditorFile, number>());
  const current = useRef<EditorFile>("paper.md");
  /** Text this editor last wrote to the store, so its own echoes are not re-applied. */
  const emitted = useRef(new Map<EditorFile, string>());
  const dir = useStore((s) => s.dir);
  const activeFile = useStore((s) => s.activeFile);

  function createState(file: EditorFile): EditorState {
    const onChange = EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        const text = u.state.doc.toString();
        emitted.current.set(file, text);
        if (file === "paper.md") setBody(text);
        else if (file === "refs.bib") setBib(text);
      }
      if (u.selectionSet || u.docChanged) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        store.set({ cursor: { line: line.number, col: head - line.from + 1 } });
      }
    });
    const extensions =
      file === "paper.md" ? markdownExtensions(onChange) : file === "refs.bib" ? bibExtensions(onChange) : texExtensions();
    return EditorState.create({ doc: contentOf(file), extensions });
  }

  // One view per project; documents swap underneath it.
  useEffect(() => {
    if (!host.current) return;
    states.current = new Map();
    scroll.current = new Map();
    current.current = "paper.md";
    const view = new EditorView({ state: createState("paper.md"), parent: host.current });
    states.current.set("paper.md", view.state);
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
    states.current.set(current.current, view.state);
    scroll.current.set(current.current, view.scrollDOM.scrollTop);
    let next = states.current.get(activeFile);
    if (!next || (activeFile === "paper.tex" && next.doc.toString() !== store.get().tex)) {
      next = createState(activeFile);
    }
    view.setState(next);
    current.current = activeFile;
    requestAnimationFrame(() => (view.scrollDOM.scrollTop = scroll.current.get(activeFile) ?? 0));
    applyLint();
  }, [activeFile]);

  // Content changed outside the editor (sidebar inserted a bib entry, paper.tex regenerated).
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        const view = viewRef.current;
        if (!view) return;
        for (const file of FILES) {
          const value = file === "paper.md" ? s.body : file === "refs.bib" ? s.bib : s.tex;
          const before = file === "paper.md" ? prev.body : file === "refs.bib" ? prev.bib : prev.tex;
          if (value === before || value === emitted.current.get(file)) continue;
          if (file === current.current) {
            if (view.state.doc.toString() !== value) {
              view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
            }
          } else {
            states.current.delete(file);
          }
        }
      }),
    [],
  );

  function applyLint() {
    const view = viewRef.current;
    if (!view) return;
    const { diagnostics, body } = store.get();
    const file = current.current;
    const doc = view.state.doc;
    const marks: CmDiagnostic[] = [];
    for (const d of locate(diagnostics, body)) {
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

  // Jump requests from the outline, problems panel and the PDF preview.
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
