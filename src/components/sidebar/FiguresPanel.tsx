import type { EditorView } from "@codemirror/view";
import { FileText, ImagePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { insertBlock } from "@/editor/commands";
import { editorBridge, withEditor } from "@/editor/bridge";
import { FIGURE_EXTENSIONS, uniqueFigureLabel } from "@/editor/figureSyntax";
import { api, joinPath } from "@/lib/api";
import { labels } from "@/lib/outline";
import { allText } from "@/lib/parts";
import { importPickedFigure, pickFiles, type PickedFile } from "@/lib/platform";
import { refreshFigures } from "@/session";
import { store, useStore } from "@/store";
import { notify } from "../Toaster";
import { Button } from "../ui";

export { FIGURE_EXTENSIONS };

/** Every `#fig:` label in the document. */
export function figureLabels(): string[] {
  return labels(allText(store.get().parts)).fig;
}

/** The figure snippet for `path`, its label derived from the file name and not yet used. */
export function figureSnippet(path: string): string {
  const stem = (path.split("/").pop() ?? "figure").replace(/\.[^.]+$/, "");
  return `![\${Caption}](${path}){#\${${uniqueFigureLabel(stem, figureLabels())}} width=80%}`;
}

export async function importFigures(files: PickedFile[]): Promise<string[]> {
  const dir = store.get().dir;
  if (!dir) return [];
  const imported: string[] = [];
  for (const f of files) imported.push(await importPickedFigure(dir, f));
  await refreshFigures();
  return imported;
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Saves pasted files (named with a figure extension) into figures/ and inserts their snippets. */
export async function pasteFigures(view: EditorView, files: { file: Blob; name: string }[]) {
  const { dir, activeFile } = store.get();
  if (!dir) return;
  const added: string[] = [];
  for (const f of files) added.push(await api.importFigureBytes(dir, f.name, await base64(f.file)));
  await refreshFigures();
  if (editorBridge.view === view && store.get().activeFile === activeFile) {
    for (const path of added) insertBlock(view, figureSnippet(path));
  }
  notify(`Added ${added.length === 1 ? added[0] : `${added.length} figures`}`);
}

function Thumbnail({ path }: { path: string }) {
  const dir = useStore((s) => s.dir)!;
  const [url, setUrl] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const isPdf = path.toLowerCase().endsWith(".pdf");

  useEffect(() => {
    if (isPdf || !ref.current) return;
    let objectUrl: string | null = null;
    // Decode only thumbnails that scroll into view.
    const io = new IntersectionObserver(async ([entry]) => {
      if (!entry.isIntersecting || objectUrl) return;
      io.disconnect();
      const bytes = await api.readBinary(joinPath(dir, path));
      objectUrl = URL.createObjectURL(new Blob([bytes]));
      setUrl(objectUrl);
    });
    io.observe(ref.current);
    return () => {
      io.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [dir, path, isPdf]);

  return (
    <div ref={ref} className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md bg-raised">
      {isPdf ? (
        <FileText className="text-faint" />
      ) : url ? (
        <img src={url} alt="" className="h-full w-full object-contain" decoding="async" />
      ) : null}
    </div>
  );
}

export function FiguresPanel() {
  const figures = useStore((s) => s.figures);

  async function pick() {
    const picked = await pickFiles("Images", FIGURE_EXTENSIONS);
    if (picked.length === 0) return;
    const added = await importFigures(picked);
    notify(`Added ${added.length} figure${added.length === 1 ? "" : "s"}`);
  }

  return (
    <div className="space-y-3 p-3">
      <Button className="w-full" onClick={() => void pick().catch((e) => notify(String(e), "error"))}>
        <ImagePlus size={14} /> Add images
      </Button>
      <p className="text-[11px] text-faint">PNG, JPG or PDF. You can also drop or paste them into the editor.</p>
      <div className="grid grid-cols-2 gap-2">
        {figures.map((path) => (
          <button
            key={path}
            className="group space-y-1 text-left cursor-default"
            title="Insert figure"
            onClick={() => withEditor((v) => insertBlock(v, figureSnippet(path)))}
          >
            <div className="rounded-md ring-accent group-hover:ring-2">
              <Thumbnail path={path} />
            </div>
            <div className="truncate font-mono text-[10px] text-muted">{path.replace(/^figures\//, "")}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
