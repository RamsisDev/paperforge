import { FilePlus, FolderOpen, Users, X } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { openProjectAt, openProjectDialog } from "@/actions";
import { joinSession } from "@/collab";
import { inviteInLocation } from "@/collab/invite";
import { hasLocalBackend } from "@/lib/platform";
import { forgetProject, recentProjects } from "@/lib/recent";
import { TEMPLATES } from "@/lib/templates";
import { openGallery, store } from "@/store";
import { notify } from "./Toaster";
import { Button, Field, Input, MOD } from "./ui";

function Action({ icon, title, detail, onClick }: { icon: ReactNode; title: string; detail: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 rounded-xl border border-line bg-panel p-4 text-left transition hover:border-accent hover:shadow-md cursor-default"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-soft text-accent">{icon}</span>
      <span>
        <span className="block text-[14px] font-medium text-fg">{title}</span>
        <span className="block text-xs text-muted">{detail}</span>
      </span>
    </button>
  );
}

function run(task: () => Promise<unknown>) {
  task().catch((e) => notify(String(e), "error"));
}

function JoinForm({ invite, onCancel }: { invite: string; onCancel?: () => void }) {
  const [code, setCode] = useState(invite);
  const [name, setName] = useState(() => store.get().commentAuthor);
  const [busy, setBusy] = useState(false);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !code.trim() || !name.trim()) return;
    setBusy(true);
    joinSession(code, name.trim())
      .catch((err) => notify(err instanceof Error ? err.message : String(err), "error"))
      .finally(() => setBusy(false));
  }
  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-accent bg-panel p-4">
      <p className="text-xs text-muted">Edit a paper someone shares on your network. Ask them for the code, or open their link.</p>
      <Field label="Code or link">
        <Input
          autoFocus={!invite}
          value={code}
          placeholder="e.g. 60N00J-A1D003-ZGF01A"
          className="font-mono"
          onChange={(e) => setCode(e.target.value)}
        />
      </Field>
      <Field label="Your name" hint="shown next to your cursor">
        <Input autoFocus={!!invite} value={name} maxLength={40} placeholder="e.g. Ana" onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={busy || !code.trim() || !name.trim()}>
          {busy ? "Joining…" : "Join"}
        </Button>
      </div>
    </form>
  );
}

export function Welcome() {
  const [recent, setRecent] = useState(recentProjects);
  const [invite] = useState(inviteInLocation);
  const [joining, setJoining] = useState(invite !== null || !hasLocalBackend);
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-8">
      <div className="w-full max-w-xl space-y-8">
        <div className="space-y-2">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent font-serif text-lg font-bold text-accent-fg">
              P
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-fg">PaperForge</h1>
          </div>
          <p className="text-sm text-muted">
            Write in Markdown, get a journal-ready PDF. {TEMPLATES.map((t) => t.label).join(", ")} — typeset locally,
            no TeX installation needed.
          </p>
        </div>

        <div className="grid gap-2.5">
          {hasLocalBackend && (
            <>
              <Action
                icon={<FilePlus size={18} />}
                title="New paper"
                detail="Pick a template, blank or from a sample, in a folder you choose"
                onClick={() => openGallery("create")}
              />
              <Action
                icon={<FolderOpen size={18} />}
                title="Open paper…"
                detail={`A folder with paper.json · ${MOD}O`}
                onClick={() => run(openProjectDialog)}
              />
            </>
          )}
          {joining ? (
            <JoinForm invite={invite ?? ""} onCancel={hasLocalBackend ? () => setJoining(false) : undefined} />
          ) : (
            <Action
              icon={<Users size={18} />}
              title="Join a session…"
              detail="Edit together with someone sharing a paper on your network"
              onClick={() => setJoining(true)}
            />
          )}
        </div>

        {hasLocalBackend && recent.length > 0 && (
          <div className="space-y-1.5">
            <h2 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Recent</h2>
            <ul className="overflow-hidden rounded-xl border border-line bg-panel">
              {recent.map((p) => (
                <li key={p.dir} className="group flex items-center border-b border-line last:border-0">
                  <button className="min-w-0 flex-1 px-4 py-2.5 text-left hover:bg-raised cursor-default" onClick={() => run(() => openProjectAt(p.dir))}>
                    <div className="truncate text-[13px] text-fg">{p.title || "Untitled"}</div>
                    <div className="truncate font-mono text-[11px] text-faint">{p.dir}</div>
                  </button>
                  <button
                    aria-label={`Remove ${p.title} from recent`}
                    className="mr-2 hidden rounded p-1 text-faint hover:bg-raised hover:text-fg group-hover:block"
                    onClick={() => {
                      forgetProject(p.dir);
                      setRecent(recentProjects());
                    }}
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
