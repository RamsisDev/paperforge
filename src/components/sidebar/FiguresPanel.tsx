import { FileText, ImagePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { insertBlock } from "@/editor/commands";
import { withEditor } from "@/editor/bridge";
import { api, joinPath } from "@/lib/api";
import { importPickedFigure, pickFiles, type PickedFile } from "@/lib/platform";
import { refreshFigures } from "@/session";
import { store, useStore } from "@/store";
import { notify } from "../Toaster";
import { Button } from "../ui";

export const FIGURE_EXTENSIONS = ["png", "jpg", "jpeg", "pdf"];

export function figureSnippet(path: string): string {
  const stem = (path.split("/").pop() ?? "figure").replace(/\.[^.]+$/, "");
  return `![\${Caption}](${path}){#fig:\${${stem}} width=80%}`;
}

export async function importFigures(files: PickedFile[]): Promise<string[]> {
  const dir = store.get().dir;
  if (!dir) return [];
  const imported: string[] = [];
  for (const f of files) imported.push(await importPickedFigure(dir, f));
  await refreshFigures();
  return imported;
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
      <p className="text-[11px] text-faint">PNG, JPG or PDF. You can also drop files on the editor.</p>
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
