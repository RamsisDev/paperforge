import { ChevronRight, FileText, Folder, House } from "lucide-react";
import { useEffect, useState } from "react";
import { api, joinPath, type FolderListing } from "@/lib/api";
import { isDesktop, registerFolderPrompt, type FolderRequest } from "@/lib/platform";
import { Button, Dialog, Input, cx } from "./ui";

const LAST_DIR = "paperforge.lastBrowseDir";

interface Pending {
  request: FolderRequest;
  resolve: (dir: string | null) => void;
}

function Crumbs({ path, onGo }: { path: string; onGo: (p: string) => void }) {
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const parts = path.split(/[\\/]/).filter(Boolean);
  const root = path.startsWith("/") ? "/" : "";
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-0.5 text-xs text-muted">
      {parts.map((part, i) => {
        const target = root + parts.slice(0, i + 1).join(sep);
        return (
          <span key={target} className="flex items-center gap-0.5">
            {i > 0 && <ChevronRight size={12} className="text-faint" />}
            <button className="rounded px-1 hover:bg-raised hover:text-fg cursor-default" onClick={() => onGo(target)}>
              {part}
            </button>
          </span>
        );
      })}
    </div>
  );
}

function Browser({ pending, onDone }: { pending: Pending; onDone: (dir: string | null) => void }) {
  const { request } = pending;
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  async function go(path: string | null) {
    try {
      const next = await api.browse(path);
      setListing(next);
      setError(null);
      localStorage.setItem(LAST_DIR, next.path);
    } catch (e) {
      setError(String(e));
      if (path !== null && !listing) void go(null);
    }
  }

  useEffect(() => void go(localStorage.getItem(LAST_DIR)), []);

  const creating = request.mode === "create";
  const target = listing && (creating && newName.trim() ? joinPath(listing.path, newName.trim()) : listing.path);
  const canChoose = !!listing && (creating ? !listing.isProject || newName.trim() !== "" : listing.isProject);

  return (
    <Dialog title={request.title} onClose={() => onDone(null)} className="h-[560px] max-w-xl">
      <div className="flex items-center gap-2 px-5 pt-3">
        <button
          aria-label="Home folder"
          className="rounded p-1 text-muted hover:bg-raised hover:text-fg cursor-default"
          onClick={() => void go(listing?.home ?? null)}
        >
          <House size={14} />
        </button>
        {listing && <Crumbs path={listing.path} onGo={(p) => void go(p)} />}
      </div>
      <ul className="mx-5 mt-3 min-h-0 flex-1 overflow-auto rounded-lg border border-line">
        {listing?.parent && (
          <li>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-muted hover:bg-raised cursor-default"
              onClick={() => void go(listing.parent)}
            >
              <Folder size={14} /> ..
            </button>
          </li>
        )}
        {listing?.dirs.map((d) => (
          <li key={d.path}>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-fg hover:bg-raised cursor-default"
              onClick={() => void go(d.path)}
              onDoubleClick={() => !creating && d.isProject && onDone(d.path)}
            >
              {d.isProject ? <FileText size={14} className="text-accent" /> : <Folder size={14} className="text-faint" />}
              <span className="truncate">{d.name}</span>
              {d.isProject && <span className="ml-auto text-[11px] text-accent">paper</span>}
            </button>
          </li>
        ))}
        {listing && listing.dirs.length === 0 && <li className="px-3 py-2 text-xs text-faint">No folders here.</li>}
      </ul>
      {error && <p className="px-5 pt-2 text-xs text-danger">{error}</p>}
      {creating && (
        <div className="px-5 pt-3">
          <Input
            data-autofocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New folder name (optional: uses the current folder when empty)"
          />
        </div>
      )}
      <div className="mt-3 flex items-center gap-2 border-t border-line px-5 py-3">
        <p className={cx("min-w-0 flex-1 truncate font-mono text-[11px]", canChoose ? "text-muted" : "text-faint")} title={target ?? ""}>
          {creating
            ? listing?.isProject && !newName.trim()
              ? "This folder already has a paper: open it, or name a new folder."
              : target
            : listing?.isProject
              ? target
              : "Pick a folder marked “paper”."}
        </p>
        <Button variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canChoose} onClick={() => target && onDone(target)}>
          {creating ? "Create here" : "Open"}
        </Button>
      </div>
    </Dialog>
  );
}

/** Browser stand-in for the native folder dialog; renders nothing on the desktop. */
export function FolderPickerHost() {
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    if (isDesktop) return;
    registerFolderPrompt((request) => new Promise((resolve) => setPending({ request, resolve })));
    return () => registerFolderPrompt(null);
  }, []);

  if (!pending) return null;
  return (
    <Browser
      pending={pending}
      onDone={(dir) => {
        pending.resolve(dir);
        setPending(null);
      }}
    />
  );
}
