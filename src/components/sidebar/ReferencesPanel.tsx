import { open } from "@tauri-apps/plugin-dialog";
import { FileText, Plus, Search, Upload } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { insertInline } from "@/editor/commands";
import { withEditor } from "@/editor/bridge";
import { api } from "@/lib/api";
import { parseBib, shortAuthors } from "@/lib/bib";
import { setBib } from "@/session";
import { jumpTo, store, useStore } from "@/store";
import { notify } from "../Toaster";
import { Button, Input } from "../ui";

const NEW_ENTRY = `@article{key2026,
  author  = {Last, First and Other, Author},
  title   = {Title of the Paper},
  journal = {Journal Name},
  year    = {2026},
  volume  = {1},
  pages   = {1--10},
  doi     = {}
}
`;

function appendBib(text: string) {
  const bib = store.get().bib;
  const sep = bib.trim() === "" ? "" : bib.endsWith("\n\n") ? "" : bib.endsWith("\n") ? "\n" : "\n\n";
  setBib(bib + sep + text);
  return (bib + sep).split("\n").length - 1;
}

export function ReferencesPanel() {
  const bib = useDeferredValue(useStore((s) => s.bib));
  const entries = useMemo(() => parseBib(bib), [bib]);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q
    ? entries.filter((e) => `${e.key} ${e.author} ${e.title} ${e.year}`.toLowerCase().includes(q))
    : entries;

  async function importBib() {
    const picked = await open({ multiple: true, filters: [{ name: "BibTeX", extensions: ["bib"] }] });
    if (!picked) return;
    const known = new Set(parseBib(store.get().bib).map((e) => e.key));
    let added = 0;
    for (const path of [picked].flat()) {
      const text = new TextDecoder().decode(await api.readBinary(path));
      const fresh = parseBib(text).filter((e) => !known.has(e.key));
      if (fresh.length === 0) continue;
      fresh.forEach((e) => known.add(e.key));
      appendBib(text.trim() + "\n");
      added += fresh.length;
    }
    notify(added ? `Imported ${added} reference${added === 1 ? "" : "s"}` : "No new references in that file");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search references" className="pl-8" />
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" onClick={() => jumpTo("refs.bib", appendBib(NEW_ENTRY))}>
            <Plus size={13} /> New
          </Button>
          <Button size="sm" onClick={() => void importBib().catch((e) => notify(String(e), "error"))}>
            <Upload size={13} /> Import .bib
          </Button>
          <Button size="sm" variant="ghost" onClick={() => jumpTo("refs.bib", 0)}>
            <FileText size={13} /> Edit
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {shown.length === 0 && (
          <p className="p-3 text-xs text-muted">
            {entries.length === 0 ? "No references yet. Add one or import a .bib file." : "Nothing matches."}
          </p>
        )}
        {shown.map((e) => (
          <div key={e.key} className="group rounded-md px-2 py-1.5 hover:bg-raised">
            <button
              className="block w-full text-left cursor-default"
              title="Insert citation"
              onClick={() => withEditor((v) => insertInline(v, `[@${e.key}]`))}
            >
              <div className="flex items-baseline gap-2">
                <span className="truncate font-mono text-[11px] text-accent">@{e.key}</span>
                <span className="ml-auto shrink-0 text-[11px] text-faint">{e.year}</span>
              </div>
              <div className="line-clamp-2 text-[12px] leading-snug text-fg">{e.title || <em className="text-faint">No title</em>}</div>
              <div className="truncate text-[11px] text-muted">{shortAuthors(e.author)}</div>
            </button>
            <button
              className="hidden text-[11px] text-faint hover:text-accent group-hover:block cursor-default"
              onClick={() => jumpTo("refs.bib", e.line - 1)}
            >
              Edit entry
            </button>
          </div>
        ))}
      </div>
      <p className="border-t border-line px-3 py-2 text-[11px] text-faint">Type @ in the editor to cite by key.</p>
    </div>
  );
}
