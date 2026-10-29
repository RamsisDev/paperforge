// One WebSocket to the host's collaboration listener, carrying every room (a part or refs.bib),
// presence, the host's compiles and a guest's backend commands. Binary frames are
// `[varString channel][payload]`; a room's payload is a y-protocols sync or awareness message,
// and the channels `#pdf` and `#reply:<id>` carry the shared PDF and binary command replies.
// Text frames are JSON control messages (see `src-tauri/src/collab/server.rs`).

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { CompileOutcome, ProjectSnapshot } from "@/lib/api";
import { BIB_FILE, type CollabPeer, type EditorFile } from "@/store";
import type { SharedText } from "./live";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;
const PDF_CHANNEL = "#pdf";
const REPLY_CHANNEL = "#reply:";
const RECONNECT_ATTEMPTS = 6;
const RECONNECT_MAX_MS = 5000;
/** Marks updates that came from the host, so they are not sent back. */
const REMOTE = Symbol("remote");

export interface Hello {
  you: number;
  role: "host" | "guest";
  name: string;
  color: string;
  snapshot: ProjectSnapshot;
  peers: CollabPeer[];
}

export interface Credentials {
  name: string;
  code?: string;
  hostKey?: string;
}

export interface Handlers {
  /** `again` after a reconnection. */
  hello(hello: Hello, again: boolean): void;
  peers(peers: CollabPeer[]): void;
  snapshot(snapshot: ProjectSnapshot): void;
  /** A shared file's text, after it synced and after every change. */
  text(file: EditorFile, text: string): void;
  synced(file: EditorFile): void;
  /** The host deleted the part. */
  closed(file: EditorFile): void;
  compiling(): void;
  compiled(outcome: CompileOutcome): void;
  pdf(bytes: Uint8Array): void;
  reconnecting(): void;
  /** The session is over for this window; `reason` says why when it was not asked for. */
  ended(reason: string | null): void;
}

class Room implements SharedText {
  doc = new Y.Doc();
  text = this.doc.getText("content");
  awareness = new awarenessProtocol.Awareness(this.doc);
  undo = new Y.UndoManager(this.text);
  synced = false;

  destroy() {
    this.awareness.destroy();
    this.undo.destroy();
    this.doc.destroy();
  }
}

const roomOf = (file: EditorFile) => (file === BIB_FILE ? "bib" : `part:${file}`);
const fileOf = (room: string): EditorFile | null =>
  room === "bib" ? BIB_FILE : room.startsWith("part:") ? room.slice("part:".length) : null;

function frame(channel: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, channel);
  encoding.writeUint8Array(encoder, payload);
  return new Uint8Array(encoding.toUint8Array(encoder));
}

export class CollabClient {
  private socket: WebSocket | null = null;
  private rooms = new Map<EditorFile, Room>();
  private calls = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  private nextCall = 1;
  private attempts = 0;
  private over = false;
  private helloed = false;
  private user = { name: "", color: "#888888", colorLight: "#88888833" };

  constructor(
    private url: string,
    private credentials: Credentials,
    private handlers: Handlers,
  ) {}

  /** Resolves with the first hello; rejects when the host refuses or cannot be reached. */
  connect(): Promise<Hello> {
    return new Promise((resolve, reject) => this.open(resolve, reject));
  }

  private open(resolve?: (hello: Hello) => void, reject?: (reason: string) => void) {
    const socket = new WebSocket(this.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    let greeted = false;
    socket.onopen = () => socket.send(JSON.stringify({ t: "auth", ...this.credentials }));
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return this.binary(new Uint8Array(event.data as ArrayBuffer));
      const message = JSON.parse(event.data);
      if (message.t === "hello") {
        greeted = true;
        this.welcome(message as Hello);
        resolve?.(message as Hello);
      } else if (message.t === "denied") {
        this.over = true;
        if (reject) reject(message.reason);
        else this.handlers.ended(message.reason);
      } else {
        this.control(message);
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.dropRemoteState();
      for (const call of this.calls.values()) call.reject("Lost the connection to the host.");
      this.calls.clear();
      if (!greeted && reject && !this.over) {
        this.over = true;
        reject(`Could not reach the host at ${new URL(this.url).host}. Check that you are on the same network.`);
      } else if (!this.over) {
        this.reconnect();
      }
    };
  }

  private reconnect() {
    if (this.attempts >= RECONNECT_ATTEMPTS) {
      this.close();
      this.handlers.ended("Lost the connection to the host.");
      return;
    }
    this.handlers.reconnecting();
    const delay = Math.min(500 * 2 ** this.attempts++, RECONNECT_MAX_MS);
    setTimeout(() => !this.over && this.open(), delay);
  }

  private welcome(hello: Hello) {
    this.attempts = 0;
    this.user = { name: hello.name, color: hello.color, colorLight: `${hello.color}33` };
    const again = this.helloed;
    this.helloed = true;
    // After a reconnection the rooms sync again; offline edits merge both ways.
    for (const [file, room] of this.rooms) {
      room.awareness.setLocalStateField("user", this.user);
      this.sendSyncStep1(file, room);
    }
    this.handlers.hello(hello, again);
  }

  private control(message: { t: string; [key: string]: unknown }) {
    switch (message.t) {
      case "peers":
        return this.handlers.peers(message.peers as CollabPeer[]);
      case "snapshot":
        return this.handlers.snapshot(message.snapshot as ProjectSnapshot);
      case "closed": {
        const file = fileOf(message.room as string);
        if (file !== null && this.rooms.has(file)) {
          this.unsubscribe(file);
          this.handlers.closed(file);
        }
        return;
      }
      case "compiling":
        return this.handlers.compiling();
      case "compiled":
        return this.handlers.compiled(message.outcome as CompileOutcome);
      case "reply": {
        const call = this.calls.get(message.id as number);
        this.calls.delete(message.id as number);
        if ("err" in message) call?.reject(message.err);
        else call?.resolve(message.ok);
        return;
      }
      case "ended":
        this.close();
        return this.handlers.ended("The host stopped sharing the paper.");
    }
  }

  private binary(data: Uint8Array) {
    const decoder = decoding.createDecoder(data);
    const channel = decoding.readVarString(decoder);
    const payload = data.subarray(decoder.pos);
    if (channel === PDF_CHANNEL) return this.handlers.pdf(payload.slice());
    if (channel.startsWith(REPLY_CHANNEL)) {
      const id = Number(channel.slice(REPLY_CHANNEL.length));
      this.calls.get(id)?.resolve(payload.slice().buffer);
      this.calls.delete(id);
      return;
    }
    const file = fileOf(channel);
    const room = file === null ? undefined : this.rooms.get(file);
    if (file === null || !room) return;
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MESSAGE_SYNC);
      const kind = syncProtocol.readSyncMessage(decoder, reply, room.doc, REMOTE);
      if (encoding.length(reply) > 1) this.send(frame(channel, encoding.toUint8Array(reply)));
      if (kind === syncProtocol.messageYjsSyncStep2 && !room.synced) {
        room.synced = true;
        this.handlers.synced(file);
        this.handlers.text(file, room.text.toString());
      }
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), REMOTE);
    } else if (type === MESSAGE_QUERY_AWARENESS) {
      this.sendAwareness(file, room, [room.doc.clientID]);
    }
  }

  private send(data: Uint8Array<ArrayBuffer> | string) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(data);
  }

  private sendSyncStep1(file: EditorFile, room: Room) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    this.send(frame(roomOf(file), encoding.toUint8Array(encoder)));
  }

  private sendAwareness(file: EditorFile, room: Room, clients: number[]) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, clients));
    this.send(frame(roomOf(file), encoding.toUint8Array(encoder)));
  }

  /** Other people's cursors disappear while the host is unreachable. */
  private dropRemoteState() {
    for (const room of this.rooms.values()) {
      const others = [...room.awareness.getStates().keys()].filter((id) => id !== room.doc.clientID);
      awarenessProtocol.removeAwarenessStates(room.awareness, others, REMOTE);
    }
  }

  room(file: EditorFile): SharedText | undefined {
    return this.rooms.get(file);
  }

  files(): EditorFile[] {
    return [...this.rooms.keys()];
  }

  subscribe(file: EditorFile): SharedText {
    const existing = this.rooms.get(file);
    if (existing) return existing;
    const room = new Room();
    this.rooms.set(file, room);
    const channel = roomOf(file);
    room.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.send(frame(channel, encoding.toUint8Array(encoder)));
    });
    room.awareness.on("update", ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
      if (origin === "local") this.sendAwareness(file, room, [...added, ...updated, ...removed]);
    });
    room.text.observe(() => {
      if (room.synced) this.handlers.text(file, room.text.toString());
    });
    room.awareness.setLocalStateField("user", this.user);
    this.sendSyncStep1(file, room);
    return room;
  }

  unsubscribe(file: EditorFile) {
    const room = this.rooms.get(file);
    if (!room) return;
    this.rooms.delete(file);
    awarenessProtocol.removeAwarenessStates(room.awareness, [room.doc.clientID], "local");
    room.destroy();
  }

  presence(file: EditorFile | null) {
    this.send(JSON.stringify({ t: "presence", file }));
  }

  /** A backend command run by the host, on the shared project. */
  call(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject("Not connected to the host right now. Try again in a moment.");
    }
    const id = this.nextCall++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.send(JSON.stringify({ t: "call", id, cmd, args }));
    });
  }

  close() {
    this.over = true;
    for (const file of this.files()) this.unsubscribe(file);
    for (const call of this.calls.values()) call.reject("Left the shared session.");
    this.calls.clear();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}
