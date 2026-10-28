import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FileCode, FileText, BookOpen } from "lucide-react";
import { useEffect } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { exportPdf, openProjectDialog } from "@/actions";
import { insertBlock } from "@/editor/commands";
import { editorBridge } from "@/editor/bridge";
import { api } from "@/lib/api";
import { parseBib } from "@/lib/bib";
import { compileNow, refreshTex, setBib } from "@/session";
import { store, useStore, type EditorFile } from "@/store";
import { Editor } from "./Editor";
import { Preview } from "./Preview";
import { ProblemsPanel } from "./ProblemsPanel";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { notify } from "./Toaster";
import { Toolbar } from "./Toolbar";
import { FIGURE_EXTENSIONS, figureSnippet, importFigures } from "./sidebar/FiguresPanel";
import { Tabs } from "./ui";

function Handle() {
  return (
    <Separator className="group relative w-px bg-line outline-none data-[separator=active]:bg-accent hover:bg-accent">
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </Separator>
  );
}

function EditorPane() {
  const activeFile = useStore((s) => s.activeFile);
  const problemsOpen = useStore((s) => s.problemsOpen);
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <Tabs<EditorFile>
        className="h-9 shrink-0 border-b border-line px-1.5"
        value={activeFile}
        onChange={(file) => {
          if (file === "paper.tex") void refreshTex();
          store.set({ activeFile: file });
        }}
        tabs={[
          { id: "paper.md", label: "paper.md", icon: <FileText size={13} /> },
          { id: "refs.bib", label: "refs.bib", icon: <BookOpen size={13} /> },
          { id: "paper.tex", label: "paper.tex (generated)", icon: <FileCode size={13} /> },
        ]}
      />
      <div className="min-h-0 flex-1">
        <Editor />
      </div>
      {problemsOpen && (
        <div className="h-44 shrink-0">
          <ProblemsPanel />
        </div>
      )}
    </div>
  );
}

function extensionOf(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

/** Files dropped on the window: images become figures at the drop point, .bib files merge. */
function useFileDrop() {
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type !== "drop") return;
      const { paths, position } = event.payload;
      try {
        const images = paths.filter((p) => FIGURE_EXTENSIONS.includes(extensionOf(p)));
        const bibs = paths.filter((p) => extensionOf(p) === "bib");
        if (images.length) {
          const added = await importFigures(images);
          const view = editorBridge.view;
          if (view && store.get().activeFile === "paper.md") {
            const ratio = window.devicePixelRatio || 1;
            const pos = view.posAtCoords({ x: position.x / ratio, y: position.y / ratio });
            if (pos !== null) view.dispatch({ selection: { anchor: pos } });
            for (const path of added) insertBlock(view, figureSnippet(path));
          }
          notify(`Added ${added.length} figure${added.length === 1 ? "" : "s"}`);
        }
        for (const path of bibs) {
          const text = new TextDecoder().decode(await api.readBinary(path));
          const known = new Set(parseBib(store.get().bib).map((e) => e.key));
          const fresh = parseBib(text).filter((e) => !known.has(e.key));
          if (fresh.length) setBib(`${store.get().bib.trimEnd()}\n\n${text.trim()}\n`);
          notify(`Imported ${fresh.length} reference${fresh.length === 1 ? "" : "s"}`);
        }
      } catch (e) {
        notify(String(e), "error");
      }
    });
    return () => void unlisten.then((f) => f());
  }, []);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      const act = (fn: () => unknown) => {
        e.preventDefault();
        Promise.resolve(fn()).catch((err) => notify(String(err), "error"));
      };
      if (key === "s" && !e.shiftKey) act(() => compileNow("full"));
      else if (key === "enter") act(() => compileNow("preview"));
      else if (key === "e" && e.shiftKey) act(exportPdf);
      else if (key === "o") act(openProjectDialog);
      else if (key === "\\") act(() => store.set((s) => ({ sidebarOpen: !s.sidebarOpen })));
      else if (key === "j") act(() => store.set((s) => ({ problemsOpen: !s.problemsOpen })));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function Workspace() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  useFileDrop();
  useShortcuts();
  return (
    <div className="flex h-full flex-col">
      <Toolbar />
      <Group orientation="horizontal" className="min-h-0 flex-1">
        {sidebarOpen && (
          <>
            <Panel id="sidebar" defaultSize="21" minSize={240} maxSize="38">
              <Sidebar />
            </Panel>
            <Handle />
          </>
        )}
        <Panel id="editor" defaultSize="40" minSize="22">
          <EditorPane />
        </Panel>
        <Handle />
        <Panel id="preview" defaultSize="39" minSize="20">
          <Preview />
        </Panel>
      </Group>
      <StatusBar />
    </div>
  );
}
