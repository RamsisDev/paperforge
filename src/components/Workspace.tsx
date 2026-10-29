import { BookOpen, ChevronsUpDown, FileCode, FileCog, FilePlus, FileText } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useShallow } from "zustand/react/shallow";
import { exportPdf, openProjectDialog } from "@/actions";
import { insertBlock } from "@/editor/commands";
import { editorBridge } from "@/editor/bridge";
import { baseName } from "@/lib/api";
import { onFileDrop, readPickedText } from "@/lib/platform";
import { parseBib } from "@/lib/bib";
import { partTitle } from "@/lib/parts";
import { unitName } from "@/lib/templates";
import { compileNow, refreshTex, setBib } from "@/session";
import { BIB_FILE, PREAMBLE_FILE, TEX_FILE, askNewPart, isPartFile, openFile, store, useStore, type EditorFile } from "@/store";
import { Editor } from "./Editor";
import { HistoryDiffView } from "./HistoryDiffView";
import { Preview } from "./Preview";
import { ProblemsPanel } from "./ProblemsPanel";
import { SaveVersionHost } from "./SaveVersionDialog";
import { ShareHost } from "./ShareDialog";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { notify } from "./Toaster";
import { Toolbar } from "./Toolbar";
import { FIGURE_EXTENSIONS, figureSnippet, importFigures } from "./sidebar/FiguresPanel";
import { IconButton, MENU_SEPARATOR, Menu, Tabs } from "./ui";

function Handle() {
  return (
    <Separator className="group relative w-px bg-line outline-none data-[separator=active]:bg-accent hover:bg-accent">
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </Separator>
  );
}

/** Lists every part in reading order; the tab bar shows only the one being edited. */
function PartSwitcher({ current }: { current: EditorFile }) {
  const titles = useStore(useShallow((s) => s.parts.map(partTitle)));
  const files = useStore(useShallow((s) => s.parts.map((p) => p.file)));
  const unit = useStore((s) => unitName(s.meta?.template));
  return (
    <Menu
      align="start"
      className="shrink-0"
      trigger={
        <IconButton label={`All ${unit}s (${files.length})`} aria-haspopup="menu">
          <ChevronsUpDown size={14} />
        </IconButton>
      }
      items={[
        ...files.map((file, i) => ({
          key: file,
          label: `${i + 1}. ${titles[i]}`,
          hint: baseName(file),
          active: file === current,
          onSelect: () => openFile(file),
        })),
        MENU_SEPARATOR,
        {
          label: `Add ${unit}…`,
          icon: <FilePlus size={14} />,
          onSelect: () => askNewPart(Math.max(0, files.indexOf(current)) + 1),
        },
      ]}
    />
  );
}

function EditorPane() {
  const activeFile = useStore((s) => s.activeFile);
  const problemsOpen = useStore((s) => s.problemsOpen);
  const hasPreamble = useStore((s) => s.preamble !== null);
  // The part tab keeps pointing at the last part edited while refs.bib or the LaTeX is shown.
  const lastPart = useRef<EditorFile>("");
  const files = useStore(useShallow((s) => s.parts.map((p) => p.file)));
  if (isPartFile(activeFile)) lastPart.current = activeFile;
  if (!files.includes(lastPart.current)) lastPart.current = files[0] ?? "";
  const partFile = lastPart.current;
  const partLabel = useStore((s) => {
    const part = s.parts.find((p) => p.file === partFile);
    return part ? partTitle(part) : "";
  });
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
        <PartSwitcher current={partFile} />
        <Tabs<EditorFile>
          className="min-w-0"
          value={activeFile}
          onChange={(file) => {
            if (file === TEX_FILE) void refreshTex();
            openFile(file);
          }}
          tabs={[
            { id: partFile, label: partLabel, icon: <FileText size={13} />, truncate: true },
            { id: BIB_FILE, label: BIB_FILE, icon: <BookOpen size={13} /> },
            ...(hasPreamble ? [{ id: PREAMBLE_FILE, label: PREAMBLE_FILE, icon: <FileCog size={13} /> }] : []),
            { id: TEX_FILE, label: "LaTeX (generated)", icon: <FileCode size={13} /> },
          ]}
        />
      </div>
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

/** The compare view covers the editor, which stays mounted with its undo history and scroll. */
function EditorArea({ children }: { children: ReactNode }) {
  const comparing = useStore((s) => s.compare !== null);
  return (
    <div className="relative h-full">
      {children}
      {comparing && (
        <div className="absolute inset-0 z-10">
          <HistoryDiffView />
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
  useEffect(
    () =>
      onFileDrop(async ({ files, x, y }) => {
        try {
          const images = files.filter((f) => FIGURE_EXTENSIONS.includes(extensionOf(f.name)));
          const bibs = files.filter((f) => extensionOf(f.name) === "bib");
          if (images.length) {
            const added = await importFigures(images);
            const view = editorBridge.view;
            if (view && isPartFile(store.get().activeFile)) {
              const pos = view.posAtCoords({ x, y });
              if (pos !== null) view.dispatch({ selection: { anchor: pos } });
              for (const path of added) insertBlock(view, figureSnippet(path));
            }
            notify(`Added ${added.length} figure${added.length === 1 ? "" : "s"}`);
          }
          for (const file of bibs) {
            const text = await readPickedText(file);
            const known = new Set(parseBib(store.get().bib).map((e) => e.key));
            const fresh = parseBib(text).filter((e) => !known.has(e.key));
            if (fresh.length) setBib(`${store.get().bib.trimEnd()}\n\n${text.trim()}\n`);
            notify(`Imported ${fresh.length} reference${fresh.length === 1 ? "" : "s"}`);
          }
        } catch (e) {
          notify(String(e), "error");
        }
      }),
    [],
  );
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
      else if (key === "s") act(() => store.set({ versionDialog: true }));
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
            <Panel id="sidebar" defaultSize="23" minSize={240} maxSize="38">
              <Sidebar />
            </Panel>
            <Handle />
          </>
        )}
        <Panel id="editor" defaultSize="39" minSize="22">
          <EditorArea>
            <EditorPane />
          </EditorArea>
        </Panel>
        <Handle />
        <Panel id="preview" defaultSize="38" minSize="20">
          <Preview />
        </Panel>
      </Group>
      <StatusBar />
      <SaveVersionHost />
      <ShareHost />
    </div>
  );
}
