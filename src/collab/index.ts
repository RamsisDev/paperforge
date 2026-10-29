// Sharing the open paper on the local network, joining someone else's, and keeping the store in
// step with the session. The host's window joins its own session like any guest (over loopback,
// with a host key), so both edit through the same rooms.

import { api } from "@/lib/api";
import { isDesktop, setRemoteCall, setWindowTitle } from "@/lib/platform";
import {
  applyRemoteSnapshot,
  closeProject,
  dropProject,
  flushSaves,
  loadProject,
  setSharedText,
  showSharedCompile,
} from "@/session";
import { BIB_FILE, setCommentAuthor, store, useStore, type CollabState, type EditorFile } from "@/store";
import { notify } from "@/components/Toaster";
import { CollabClient, type Handlers } from "./client";
import { parseInvite } from "./invite";
import { live } from "./live";

let client: CollabClient | null = null;

function patchCollab(patch: Partial<CollabState>) {
  store.set((s) => (s.collab ? { collab: { ...s.collab, ...patch } } : {}));
}

/** A room for every part and refs.bib, and none for parts that are gone. */
function syncRooms() {
  if (!client) return;
  const wanted = new Set<EditorFile>([BIB_FILE, ...store.get().parts.map((p) => p.file)]);
  for (const file of client.files()) {
    if (!wanted.has(file)) {
      client.unsubscribe(file);
      live.texts.delete(file);
    }
  }
  for (const file of wanted) if (!live.texts.has(file)) live.texts.set(file, client.subscribe(file));
}

function forget() {
  client = null;
  live.leave = null;
  live.texts.clear();
  setRemoteCall(null);
}

function handlers(role: "host" | "guest"): Handlers {
  const guest = role === "guest";
  return {
    hello(hello, again) {
      patchCollab({ status: "connected", you: hello.you, peers: hello.peers });
      if (again && guest) applyRemoteSnapshot(hello.snapshot);
    },
    peers: (peers) => patchCollab({ peers }),
    snapshot(snapshot) {
      applyRemoteSnapshot(snapshot);
      syncRooms();
    },
    text: setSharedText,
    synced: () => store.set((s) => (s.collab ? { collab: { ...s.collab, synced: s.collab.synced + 1 } } : {})),
    closed: (file) => live.texts.delete(file),
    compiling() {
      if (guest) store.set((s) => ({ compile: { ...s.compile, state: "running" } }));
    },
    compiled(outcome) {
      if (guest) showSharedCompile(outcome);
    },
    pdf(bytes) {
      if (guest) store.set((s) => ({ pdf: { data: bytes, version: (s.pdf?.version ?? 0) + 1 } }));
    },
    reconnecting: () => patchCollab({ status: "reconnecting" }),
    ended(reason) {
      if (!client) return;
      forget();
      if (guest) dropProject();
      else {
        store.set({ collab: null });
        void api.collabStop().catch(() => {});
      }
      if (reason) notify(reason, "error");
    },
  };
}

// Others see which file each person has open; rooms follow the parts.
useStore.subscribe((s, prev) => {
  if (!client || !s.collab) return;
  if (s.activeFile !== prev.activeFile || !prev.collab) client.presence(s.activeFile || null);
  if (s.parts !== prev.parts) syncRooms();
});

/** Opens the port and joins the session as its host. */
export async function startSharing(name: string) {
  const dir = store.get().dir;
  if (!dir || client) return;
  setCommentAuthor(name);
  await flushSaves();
  const info = await api.collabStart(dir);
  const host = new CollabClient(`ws://127.0.0.1:${info.port}/collab`, { name, hostKey: info.hostKey }, handlers("host"));
  let hello;
  try {
    hello = await host.connect();
  } catch (e) {
    await api.collabStop().catch(() => {});
    throw e;
  }
  client = host;
  live.leave = stopSharing;
  store.set({ collab: { role: "host", status: "connected", you: hello.you, peers: hello.peers, info, synced: 0 } });
  syncRooms();
}

/** Closes the port; guests are told the session ended. The backend writes every text first. */
export async function stopSharing() {
  if (!client || store.get().collab?.role !== "host") return;
  client.close();
  forget();
  store.set({ collab: null });
  await api.collabStop();
}

/** Joins a session from a code or a link, replacing the open paper. */
export async function joinSession(input: string, name: string) {
  const invite = parseInvite(input);
  if (!invite) throw new Error("That is not a PaperForge code or invitation link.");
  if (store.get().dir) await closeProject();
  setCommentAuthor(name);
  // A browser that opened the link talks to the listener that served it.
  const opened = !isDesktop && location.hash.startsWith("#join=") ? location.host : invite.host;
  const guest = new CollabClient(`ws://${opened}/collab`, { name, code: invite.code }, handlers("guest"));
  const hello = await guest.connect();
  client = guest;
  live.leave = leaveSession;
  setRemoteCall((cmd, args) => guest.call(cmd, args));
  store.set({ collab: { role: "guest", status: "connected", you: hello.you, peers: hello.peers, info: null, synced: 0 } });
  loadProject(hello.snapshot);
  syncRooms();
  setWindowTitle(`${hello.snapshot.meta.title || "Untitled"} — shared by ${hostName() ?? "the host"} — PaperForge`);
}

async function leaveSession() {
  client?.close();
  forget();
}

export function hostName(): string | undefined {
  return store.get().collab?.peers.find((p) => p.role === "host")?.name;
}
