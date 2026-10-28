// The desktop app talks to Rust over Tauri IPC; in a plain browser (`npm run web`) the same
// commands go over HTTP to the dev server, and native dialogs, drops and downloads use the web
// platform instead.

import { invoke } from "@tauri-apps/api/core";

export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const WEB_HEADERS = { "x-paperforge": "1" };

async function webError(res: Response): Promise<never> {
  let message: string;
  try {
    message = String(await res.json());
  } catch {
    message = `${res.status} ${res.statusText}`;
  }
  throw message;
}

/** A backend command; rejects with the backend's error string, like Tauri's invoke. */
export async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isDesktop) return invoke<T>(command, args);
  let res: Response;
  try {
    res = await fetch(`/api/${command}`, {
      method: "POST",
      headers: { ...WEB_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
  } catch {
    throw "The PaperForge web backend is not running. Start it with `npm run web`.";
  }
  if (!res.ok) return webError(res);
  if (command === "read_binary") return (await res.arrayBuffer()) as T;
  return (await res.json()) as T;
}

/** A file chosen by the user: a path on the desktop, file contents in the browser. */
export interface PickedFile {
  name: string;
  path: string | null;
  file: File | null;
}

export async function pickFiles(label: string, extensions: string[]): Promise<PickedFile[]> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: true, filters: [{ name: label, extensions }] });
    if (!picked) return [];
    return [picked].flat().map((path) => ({ name: path.split(/[\\/]/).pop() ?? path, path, file: null }));
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = extensions.map((e) => `.${e}`).join(",");
    input.onchange = () => resolve([...(input.files ?? [])].map((file) => ({ name: file.name, path: null, file })));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function readPickedText(picked: PickedFile): Promise<string> {
  if (picked.file) return picked.file.text();
  return new TextDecoder().decode(await call<ArrayBuffer>("read_binary", { path: picked.path }));
}

/** Copies an image into the project's figures/ and returns its project-relative path. */
export async function importPickedFigure(dir: string, picked: PickedFile): Promise<string> {
  if (picked.path) return call<string>("figure_import", { dir, source: picked.path });
  const res = await fetch("/api/_upload", {
    method: "POST",
    headers: { ...WEB_HEADERS, "x-pf-dir": encodeURIComponent(dir), "x-pf-name": encodeURIComponent(picked.name) },
    body: picked.file,
  });
  if (!res.ok) return webError(res);
  return (await res.json()) as string;
}

export interface FolderRequest {
  title: string;
  /** "open" picks an existing project; "create" picks or names a folder for a new one. */
  mode: "open" | "create";
}

type FolderPrompt = (request: FolderRequest) => Promise<string | null>;
let webFolderPrompt: FolderPrompt | null = null;

/** The in-page folder browser registers itself here (browser only). */
export function registerFolderPrompt(prompt: FolderPrompt | null) {
  webFolderPrompt = prompt;
}

export async function pickFolder(request: FolderRequest): Promise<string | null> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, title: request.title });
    return typeof dir === "string" ? dir : null;
  }
  return webFolderPrompt ? webFolderPrompt(request) : null;
}

/**
 * Lets the user keep a file the backend produced. Desktop: a save dialog, then `write(dest)`
 * writes it there. Browser: the bytes from `read()` are downloaded.
 */
export async function saveOutput(options: {
  defaultName: string;
  label: string;
  extension: string;
  write: (dest: string) => Promise<void>;
  read: () => Promise<ArrayBuffer>;
}): Promise<string | null> {
  if (isDesktop) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({
      defaultPath: options.defaultName,
      filters: [{ name: options.label, extensions: [options.extension] }],
    });
    if (!dest) return null;
    await options.write(dest);
    return dest;
  }
  const url = URL.createObjectURL(new Blob([await options.read()]));
  const a = document.createElement("a");
  a.href = url;
  a.download = options.defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return options.defaultName;
}

export function setWindowTitle(title: string) {
  if (!isDesktop) {
    document.title = title;
    return;
  }
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title));
}

/**
 * Desktop: `handler` runs when the window is closed or the app is quit, and must end by calling
 * `app_quit`; the backend quits on its own a few seconds later otherwise.
 */
export function onQuitRequested(handler: () => void) {
  if (isDesktop) void import("@tauri-apps/api/event").then(({ listen }) => listen("quit-requested", handler));
}

/** Shows a project file in the OS file manager; returns false where that is not possible. */
export async function revealInFileManager(path: string): Promise<boolean> {
  if (!isDesktop) return false;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
  return true;
}

export interface FileDrop {
  files: PickedFile[];
  /** Drop point in CSS pixels of the page. */
  x: number;
  y: number;
}

/** Calls `onDrop` for files dropped on the window; returns the unsubscribe function. */
export function onFileDrop(onDrop: (drop: FileDrop) => void): () => void {
  if (isDesktop) {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type !== "drop") return;
          const ratio = window.devicePixelRatio || 1;
          onDrop({
            files: event.payload.paths.map((path) => ({ name: path.split(/[\\/]/).pop() ?? path, path, file: null })),
            x: event.payload.position.x / ratio,
            y: event.payload.position.y / ratio,
          });
        })
        .then((f) => (cancelled ? f() : (unlisten = f))),
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }
  const over = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  };
  const drop = (e: DragEvent) => {
    const list = e.dataTransfer?.files;
    if (!list || list.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    onDrop({ files: [...list].map((file) => ({ name: file.name, path: null, file })), x: e.clientX, y: e.clientY });
  };
  // Capture phase, so CodeMirror does not insert the file names as text.
  window.addEventListener("dragover", over, true);
  window.addEventListener("drop", drop, true);
  return () => {
    window.removeEventListener("dragover", over, true);
    window.removeEventListener("drop", drop, true);
  };
}
