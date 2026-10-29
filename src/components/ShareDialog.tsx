import { Check, Copy, LogOut, Radio, Users } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { hostName, startSharing, stopSharing } from "@/collab";
import { partTitle } from "@/lib/parts";
import { closeProject } from "@/session";
import { BIB_FILE, store, useStore, type CollabPeer } from "@/store";
import { notify } from "./Toaster";
import { Button, Dialog, Field, Input, cx } from "./ui";

function run(task: () => Promise<unknown>, done?: () => void) {
  task()
    .then(done)
    .catch((e) => notify(e instanceof Error ? e.message : String(e), "error"));
}

/** Pages opened over plain http on the network have no clipboard API; selecting and copying works. */
function copy(text: string, input: HTMLInputElement | null): Promise<void> {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  input?.select();
  document.execCommand("copy");
  return Promise.resolve();
}

function CopyField({ label, value, large }: { label: string; value: string; large?: boolean }) {
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <Field label={label}>
      <div className="flex gap-1.5">
        <Input
          ref={input}
          readOnly
          value={value}
          onFocus={(e) => e.target.select()}
          className={cx("font-mono", large && "h-10 text-center text-[17px] tracking-[0.12em]")}
        />
        <Button
          type="button"
          className={large ? "h-10" : undefined}
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() =>
            run(
              () => copy(value, input.current),
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
            )
          }
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </Button>
      </div>
    </Field>
  );
}

function fileLabel(file: string | null): string {
  if (!file) return "";
  if (file === BIB_FILE) return BIB_FILE;
  const part = store.get().parts.find((p) => p.file === file);
  return part ? partTitle(part) : file;
}

export function PeerDot({ peer, size = 20 }: { peer: CollabPeer; size?: number }) {
  return (
    <span
      title={peer.name}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ring-panel"
      style={{ background: peer.color, width: size, height: size, fontSize: size * 0.45 }}
    >
      {peer.name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function Participants() {
  const collab = useStore((s) => s.collab);
  if (!collab) return null;
  const max = collab.info?.maxPeers ?? 10;
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        People {collab.info ? `(${collab.peers.length} of ${max})` : `(${collab.peers.length})`}
      </div>
      <ul className="max-h-48 overflow-auto rounded-lg border border-line">
        {collab.peers.map((peer) => (
          <li key={peer.id} className="flex items-center gap-2 border-b border-line px-3 py-1.5 last:border-0">
            <PeerDot peer={peer} />
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
              {peer.name}
              {peer.id === collab.you && <span className="text-faint"> (you)</span>}
              {peer.role === "host" && <span className="ml-1.5 rounded bg-accent-soft px-1 text-[10px] font-medium text-accent">host</span>}
            </span>
            <span className="max-w-40 truncate text-[11px] text-faint">{fileLabel(peer.file)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StartSharing({ close }: { close: () => void }) {
  const [name, setName] = useState(() => store.get().commentAuthor);
  const [busy, setBusy] = useState(false);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    startSharing(name.trim())
      .catch((err) => notify(err instanceof Error ? err.message : String(err), "error"))
      .finally(() => setBusy(false));
  }
  return (
    <form onSubmit={submit} className="space-y-3 px-5 pb-4 pt-2">
      <p className="text-[12px] leading-snug text-muted">
        Opens a port on this computer so up to 9 more people on the same network can edit this paper with you, at the same
        time. They join with a code or a link; no account or internet needed. This computer saves the files and typesets
        the PDF for everyone.
      </p>
      <Field label="Your name" hint="shown next to your cursor">
        <Input data-autofocus value={name} placeholder="e.g. Ana" maxLength={40} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
          <Radio size={14} /> Start sharing
        </Button>
      </div>
    </form>
  );
}

function Hosting({ close }: { close: () => void }) {
  const info = useStore((s) => s.collab?.info);
  if (!info) return null;
  const local = info.address === "127.0.0.1";
  return (
    <div className="space-y-3 px-5 pb-4 pt-2">
      <p className="text-[12px] leading-snug text-muted">
        {local
          ? "This computer is not on a network, so only other windows on it can join."
          : "Anyone on the same network can join: in PaperForge with Join a session and the code, or by opening the link in a browser."}
      </p>
      <CopyField label="Code" value={info.code} large />
      <CopyField label="Link" value={info.link} />
      <Participants />
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={() => run(stopSharing)}>
          Stop sharing
        </Button>
        <Button type="button" variant="primary" onClick={close}>
          Done
        </Button>
      </div>
    </div>
  );
}

function Joined({ close }: { close: () => void }) {
  const title = useStore((s) => s.meta?.title || "Untitled");
  const reconnecting = useStore((s) => s.collab?.status === "reconnecting");
  return (
    <div className="space-y-3 px-5 pb-4 pt-2">
      <p className="text-[12px] leading-snug text-muted">
        You are editing “{title}”, shared by {hostName() ?? "the host"}. Their computer saves the paper and typesets the
        PDF for everyone.
        {reconnecting && <span className="block pt-1 text-amber-600">Reconnecting to the host…</span>}
      </p>
      <Participants />
      <div className="flex justify-end pt-1">
        <Button type="button" onClick={() => run(closeProject, close)}>
          <LogOut size={14} /> Leave session
        </Button>
      </div>
    </div>
  );
}

function ShareDialog() {
  const role = useStore((s) => s.collab?.role);
  const close = () => store.set({ shareDialog: false });
  return (
    <Dialog title={role === "guest" ? "Shared session" : "Share this paper"} onClose={close} className="max-w-md">
      {role === "host" ? <Hosting close={close} /> : role === "guest" ? <Joined close={close} /> : <StartSharing close={close} />}
    </Dialog>
  );
}

/** Mounted once in the workspace. */
export function ShareHost() {
  const open = useStore((s) => s.shareDialog);
  return open ? <ShareDialog /> : null;
}

/** The toolbar's Share button: who is in the session, or an invitation to start one. */
export function ShareButton() {
  const collab = useStore((s) => s.collab);
  const open = () => store.set({ shareDialog: true });
  if (!collab) {
    return (
      <Button variant="ghost" className="shrink-0" onClick={open} title="Share: edit this paper together with people on your network">
        <Users size={14} /> <span className="hidden xl:inline">Share</span>
      </Button>
    );
  }
  const shown = collab.peers.slice(0, 4);
  return (
    <button
      type="button"
      onClick={open}
      title={collab.status === "reconnecting" ? "Reconnecting to the host…" : `${collab.peers.length} in this session`}
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-1.5 hover:bg-raised cursor-default"
    >
      <span className={cx("h-2 w-2 rounded-full", collab.status === "connected" ? "bg-emerald-500" : "animate-pulse bg-amber-500")} />
      <span className="flex -space-x-1.5">
        {shown.map((peer) => (
          <PeerDot key={peer.id} peer={peer} />
        ))}
      </span>
      {collab.peers.length > shown.length && <span className="text-[11px] text-muted">+{collab.peers.length - shown.length}</span>}
    </button>
  );
}
