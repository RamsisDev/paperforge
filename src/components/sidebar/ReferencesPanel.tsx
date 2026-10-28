import { FileText, Globe, LoaderCircle, Plus, RefreshCw, Search, Unlink, Upload } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState, type FormEvent } from "react";
import { insertInline } from "@/editor/commands";
import { withEditor } from "@/editor/bridge";
import { api, baseName, type BibLookup } from "@/lib/api";
import { isDesktop, pickFiles, readPickedText } from "@/lib/platform";
import { appendToBib, parseBib, shortAuthors } from "@/lib/bib";
import { setBib } from "@/session";
import { jumpTo, store, useStore } from "@/store";
import { describeSync, syncZotero, watchZotero } from "@/zotero";
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
  const next = appendToBib(store.get().bib, text);
  setBib(next.bib);
  return next.line;
}

const knownKeys = () => parseBib(store.get().bib).map((e) => e.key);

/** Looks a DOI or arXiv id up, previews the entry, then appends it to refs.bib. */
function AddById() {
  const [query, setQuery] = useState("");
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<BibLookup | null>(null);

  async function lookUp(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q || looking) return;
    setLooking(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(await api.bibLookup(q, knownKeys()));
    } catch (err) {
      setError(String(err));
    } finally {
      setLooking(false);
    }
  }

  function add(entry: BibLookup, cite: boolean) {
    if (knownKeys().some((k) => k.toLowerCase() === entry.key.toLowerCase())) {
      setError(`refs.bib already has @${entry.key}; look it up again for a fresh key.`);
      return;
    }
    appendBib(entry.bibtex);
    if (cite) withEditor((v) => insertInline(v, `[@${entry.key}]`));
    notify(`Added @${entry.key}`);
    setPreview(null);
    setQuery("");
  }

  return (
    <div className="space-y-2">
      <form className="flex gap-1.5" onSubmit={(e) => void lookUp(e)}>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Add by DOI or arXiv id"
          aria-label="DOI or arXiv id"
          spellCheck={false}
        />
        <Button size="sm" type="submit" disabled={looking || !query.trim()} className="shrink-0">
          {looking ? <LoaderCircle size={13} className="animate-spin" /> : <Globe size={13} />} Look up
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-[11px] leading-snug text-danger">
          {error}
        </p>
      )}
      {preview && (
        <div role="group" aria-label="Reference preview" className="rounded-md border border-line bg-raised p-2">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-snug text-fg">
            {preview.bibtex}
          </pre>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" variant="primary" onClick={() => add(preview, false)}>
              Add to refs.bib
            </Button>
            <Button size="sm" onClick={() => add(preview, true)} title={`Also insert [@${preview.key}] at the cursor`}>
              Add and cite
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The link to an external .bib (a Better BibTeX auto-export) merged into refs.bib. */
function ZoteroLink() {
  const dir = useStore((s) => s.dir);
  const [linked, setLinked] = useState<string | null>(null);
  const [typedPath, setTypedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!dir) return;
    let live = true;
    api.zoteroLinked(dir).then(
      (path) => live && setLinked(path),
      () => live && setLinked(null),
    );
    return () => {
      live = false;
    };
  }, [dir]);

  async function sync() {
    try {
      const result = await syncZotero();
      notify(result ? describeSync(result) : "No Zotero export is linked");
    } catch (e) {
      notify(`Zotero sync failed: ${String(e)}`, "error");
    }
  }

  async function linkTo(path: string | null) {
    if (!dir) return;
    try {
      const next = await api.zoteroLink(dir, path);
      setLinked(next);
      setTypedPath(null);
      await watchZotero(dir);
      if (next) await sync();
    } catch (e) {
      notify(String(e), "error");
    }
  }

  async function pick() {
    // A browser file picker gives the contents but not the path the link needs.
    if (!isDesktop) return setTypedPath("");
    const [file] = await pickFiles("BibTeX", ["bib"]);
    if (file?.path) await linkTo(file.path);
  }

  if (linked) {
    return (
      <div className="flex items-center gap-1 border-t border-line px-3 py-1.5 text-[11px]">
        <span className="min-w-0 flex-1 truncate text-muted" title={linked}>
          Zotero: {baseName(linked)}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void sync()} title="Merge the export into refs.bib now">
          <RefreshCw size={12} /> Sync now
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void linkTo(null)} aria-label="Unlink Zotero export" title="Unlink">
          <Unlink size={12} />
        </Button>
      </div>
    );
  }
  if (typedPath !== null) {
    return (
      <form
        className="flex gap-1.5 border-t border-line px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          void linkTo(typedPath);
        }}
      >
        <Input
          autoFocus
          value={typedPath}
          onChange={(e) => setTypedPath(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setTypedPath(null)}
          placeholder="/path/to/My Library.bib"
          aria-label="Path of the exported .bib"
        />
        <Button size="sm" type="submit" disabled={!typedPath.trim()} className="shrink-0">
          Link
        </Button>
      </form>
    );
  }
  return (
    <div className="border-t border-line px-3 py-1.5">
      <button
        className="text-[11px] text-faint hover:text-accent cursor-default"
        onClick={() => void pick()}
        title={
          isDesktop
            ? "Merge a Better BibTeX auto-export into refs.bib whenever Zotero rewrites it"
            : "Merge a Better BibTeX auto-export into refs.bib with Sync now"
        }
      >
        Link a Zotero export…
      </button>
    </div>
  );
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
    const picked = await pickFiles("BibTeX", ["bib"]);
    if (picked.length === 0) return;
    const known = new Set(knownKeys());
    let added = 0;
    for (const file of picked) {
      const text = await readPickedText(file);
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
        <AddById />
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
      <ZoteroLink />
      <p className="border-t border-line px-3 py-2 text-[11px] text-faint">Type @ in the editor to cite by key.</p>
    </div>
  );
}
