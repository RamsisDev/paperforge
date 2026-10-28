# Plan: simultaneous local collaboration

Goal: several people edit the same paper at the same time, on the same machine or the same
LAN/office network, with no cloud service; changes propagate minimally (character-level, scoped to
a part, never whole-file overwrites) and the PDF preview keeps working.

Markers: **[V]** verified during research (code read, `npm view`/crates.io, or a prototype in
`/tmp/pf-collab/`), **[S]** assumption or untested design. Paths refer to commit `756df5f`.

## Summary

1. Yjs in the frontend (`y-codemirror.next`, `y-protocols` awareness) and `yrs` in the Rust
   backend. The host's backend is the authority: one CRDT document per part, and it is the only
   writer of the `.md` files.
2. One person hosts: a WebSocket listener on the LAN with an invitation token; guests join by
   URL/QR (mDNS as an extra). No cloud, no P2P.
3. A keystroke travels as a ~24-byte update **[V]**; an external edit of a `.md` file enters as a
   minimal diff **[V]**. Structure operations (split/merge/reorder) stay host commands, serialized.
4. The host compiles with the existing fragment cache and broadcasts PDF, diagnostics and TOC. The
   "abort the previous compile" policy must change, or nobody gets a PDF while people type **[S]**.
5. Prototype: `yrs` 0.28 + two Yjs 13 clients converge; presence, atomic materialization, disk
   diff, offline merge and token rejection work **[V]**. Typing cost with Yjs equals today's
   (p50 0.1 ms at 7.5K chars, 0.4 ms at 145K) **[V]**.

Today two windows on the same folder silently overwrite each other **[V]**: `writePending` in
`src/session.ts` sends whole contents via `api.savePart`, and `save_part`/`write_part` in
`src-tauri/src/project.rs` rewrite the file. Even "same machine" needs this design.

## Technology

| Option | Versions, license **[V]** | CM6 binding | Rust | µs/insert at 136K chars **[V]** |
|---|---|---|---|---|
| **Yjs / yrs** | yjs 13.6.33 (v14 beta), y-codemirror.next 0.3.6, y-protocols 1.0.7, y-websocket 3.1.0, yrs 0.28.0; MIT | Yes: sync, remote cursors, undo | `yrs::sync::{DefaultProtocol, Awareness}` | **6** |
| Automerge 3 | @automerge/automerge 3.5.0, crate 0.12.0, automerge-codemirror 0.2.0; MIT | Yes, no remote cursors built in | native | 100 |
| Loro | loro-crdt 1.17.1, crate 1.17.1, loro-codemirror 0.3.3; MIT | Yes | native | 20 |
| diamond-types | crate 1.0.0 (2022); ISC | No | yes | n/a |
| OT (`@codemirror/collab` 6.1.1) | MIT | Yes | no port; `ChangeSet` rebase must be reimplemented | n/a |

Snapshot load at 136K chars: Yjs 1.3 ms, Loro 3.6 ms, Automerge 88.6 ms **[V]**
(`/tmp/pf-collab/bench/crdt-compare.mjs`, 5 000 inserts).

Why Yjs: the only complete CodeMirror 6 stack (`yCollab` = `ySync` + `yRemoteSelections` +
`Y.UndoManager` undoing only your own edits); remote changes arrive as minimal CodeMirror changes
via `ySyncAnnotation`, never full replacements **[V]**; `yrs` speaks the same protocol as the JS
client **[V]**. The `y-sync` crate is abandoned, but protocol and awareness live in `yrs::sync`
(`sync` feature) **[V]**. Pin Yjs 13.x; v14 is beta.

Cheap alternative (optional phase 0): soft lock per part — one editor per part plus presence. It
covers "one person per chapter" but not simultaneous editing of the same paragraph.

## Topology and security

Host with a WebSocket relay **[S]**: on "Share", the Tauri process (or `paperforge-web`) opens a
separate listener (e.g. `0.0.0.0:1440`) serving `WS /collab` (all rooms multiplexed),
`GET /collab/pdf`, `GET/POST /collab/figures/*`, and optionally the static `dist/` so a guest can
join with just a browser. Same machine: `ws://127.0.0.1`, nothing exposed to the LAN.

Discovery: URL/QR always; mDNS (`mdns-sd` 0.21.6 **[V]**) advertising `_paperforge._tcp` with
title and host in TXT, never the token. Browsers cannot do mDNS. macOS 15+ needs
`NSLocalNetworkUsageDescription` and `NSBonjourServices` in `Info.plist`; macOS and Windows
firewalls will prompt **[S]**. WebRTC P2P rejected (`y-webrtc` 10.3.0 unpublished since 2023-12
**[V]**, still needs signaling, no gain on a LAN).

Must not be reused **[V]**: `Backend::dispatch` (`src-tauri/src/backend.rs`) accepts arbitrary paths
(`read_binary`, `project_open`, `project_create`, `export_pdf/zip`, `figure_import`), and
`src-tauri/src/bin/paperforge-web.rs` adds `_browse` (lists any folder) and `_upload` (arbitrary
`x-pf-dir`). Exposing `/api` on the LAN equals giving disk read/write. The `x-paperforge` header
guard only works because it forces a CORS preflight on `fetch`; a browser WebSocket sends no custom
headers and bypasses CORS — check `Origin` and the token, or it is open to cross-site WebSocket
hijacking.

Secure design **[S]**:

- `/api` stays on `127.0.0.1:1430`. The new listener is narrow: a message whitelist, no `dir`
  parameter (the session fixes the project), room names validated with `check_part_path` /
  `part_index` from `project.rs` and membership in `meta.parts`. (The research prototype did not
  validate room names — do not copy it as is.)
- Token: 128 random bits in the invitation URL fragment (`#t=…`, never in logs or proxies); the
  client sends it as the first message (y-protocols has `messageAuth`) or in
  `Sec-WebSocket-Protocol`. Edit/view roles, kick, token rotation, constant-time comparison,
  `max_message_size`, connection limit.
- TLS: trusted home LAN → `ws://` + token; shared office Wi-Fi → text and token travel in clear;
  option: self-signed TLS (`rcgen` + `rustls`) with the fingerprint in the QR. Over
  `http://192.168.x.x` there is no secure context (no `crypto.subtle`).
- Desktop CSP (`src-tauri/tauri.conf.json`, `connect-src 'self' ipc: http://ipc.localhost`) blocks a
  WebSocket to another IP **[V]**: add `ws: wss:` (and `http:` for the PDF, or send it over the
  socket), or let the guest's Rust backend connect as a replica and talk to its webview over IPC.

## Data model and file flow

Rooms (CRDT documents) **[S]**:

- `part:<path>` per `sections/*.md`: `Y.Text("content")` (later `Y.Map("comments")`).
- `meta`: `Y.Map` (last writer wins) for `template`, `language`, `date`, `bibStyle`, `toc`, `lof`,
  `lot`, `tocDepth`; `Y.Text` for `title` and `abstract`; `Y.Array<Y.Map>` for `authors`;
  `Y.Array` for `keywords`; `parts` as a `Y.Array` only the host writes (same rule `project::save`
  documents today **[V]**: "parts is owned by the part commands"); a host-computed outline per part
  so the Structure tab works without downloading unopened parts.
- `refs.bib`: one `Y.Text`.
- Outside the CRDT: figures (binary uploads to the host, which calls `import_figure` and
  broadcasts the new list) and `paper.tex` (derived, read-only).
- Lazy loading: one multiplexed socket with "subscribe room" messages; joining loads `meta` and the
  opened part. Needs a ~200-line custom provider: `y-websocket` opens one socket per room **[V]**
  and has no subdocument support.

Disk writes — host only:

- Materializer per room: 250 ms debounce, atomic write (reuse `write_atomic` from `project.rs`),
  and `flush_all()` before compiling, committing or closing — `compiler::compile` reads
  `paper.json` and parts from disk **[V]**. In the prototype the file matched the document after
  the debounce, with 6 writes for the whole test instead of one per keystroke **[V]**.
- No loops: keep `last_written` and compare contents, not mtime **[V]**. In collaboration mode the
  frontend disables `session.ts` writes (`writePending`, `part_save`, `project_save`) for CRDT
  files **[S]**.
- Disk watcher (`notify`, instead of the prototype's 300 ms polling) turns an external change
  (git checkout, another editor) into a character diff (`similar` 3.2.1) applied to the `Y.Text`:
  one op reaching both guests **[V]**. `yrs` uses byte offsets by default, matching the byte
  offsets of `split_markdown` / `heading_offsets` in `project.rs`; JS counts UTF-16, but updates
  carry no offsets, so they interoperate (tested with accented text) **[V]**.
- Persistence: `.paperforge/crdt/<part>.bin` (full v1 state, ~1–2 KB in the prototype **[V]**),
  **gitignored** — binary and machine-specific; git versions the `.md` files.
- Migration from plain files: only the host seeds a `Y.Text` from the `.md`, once. Two replicas
  seeding the same file independently duplicate the text on merge (`"# Intro\n# Intro\n"`) **[V]**.
- Guest offline: `y-indexeddb` 9.0.12 **[S behavior]**; on reconnect the two-step sync merges
  **[V]**; a client started before the server retried with backoff and synced **[V]**.

Concurrent structure **[S]**: split/merge/reorder/create/delete remain host commands, serialized,
operating on the CRDT text instead of the disk. For split/merge the host freezes the affected
parts (awareness flag → read-only editor for 100–200 ms), runs `split_markdown` on the current
text, seeds new rooms, deletes the moved ranges with minimal ops, then updates `parts`. Risk: an
edit arriving inside the moved range during the freeze would be lost. Reorder has no conflict
because only the host writes `parts` (Yjs has no native move; concurrent delete+insert would
duplicate). Delete closes the room and notifies whoever edits it. Today `restructure` in
`src/session.ts` serializes writes and applies the snapshot with `applySnapshot` **[V]**; in
collaboration that serialization moves to the host.

Interface with git (see `02-git-versioning.md`) **[S]**: commit = `collab.flush_all()` then commit
the materialized `.md` files, optionally with `Co-authored-by` trailers from presence.
Checkout/pull: the watcher applies diffs to the CRDT and they propagate; during a live session only
the host may do it, with confirmation. Compaction: with no guests connected, delete the `.bin` and
reseed from the `.md`; requires a per-document epoch — a guest with offline edits from an older
epoch needs a three-way merge against its base text, or a conflict copy.

## Integration design

Rust, new files **[S]**:

| File | Responsibility |
|---|---|
| `src-tauri/src/collab/mod.rs` | `Session` (dir, token, roles), `Room` (`Doc`, `Awareness`, `TextRef`, broadcast), echo suppression by `origin` |
| `collab/materialize.rs` | Materializer, `notify` watcher, `similar` diff, `.bin` persistence |
| `collab/protocol.rs` | Framing `[varuint room][y-protocol message]` + JSON control channel |
| `collab/server.rs` | LAN listener (`tokio-tungstenite` 0.30 or `axum` 0.8), `Origin`, token, limits |
| `collab/structure.rs` | CRDT versions of create, delete, reorder, split, merge |

Rust, changes: `backend.rs` (`collab_start`, `collab_stop`, `collab_status` added to `COMMANDS`;
new compile scheduler), `lib.rs` (`invoke_handler`, session state), `bin/paperforge-web.rs`
(starts the separate listener; `/api` stays loopback), `project.rs` (split pure logic —
`split_markdown`, `slug`, `unique_part_file` — from I/O to reuse on CRDT text), `Cargo.toml`
(`yrs = { version = "0.28", features = ["sync"] }`, `similar`, `notify`, `mdns-sd`,
`tokio-tungstenite` or `axum`), `tauri.conf.json` (CSP) and `Info.plist` (local network
permissions on macOS).

Frontend:

- `src/collab/provider.ts` (new): multiplexed socket, one `Y.Doc` per room, session and room
  awareness, IndexedDB.
- `src/components/Editor.tsx`: `createState` adds `yCollab(ytext, awareness, { undoManager })`;
  `base()` in `src/editor/extensions.ts` includes `history()`/`historyKeymap` **[V]** — replace with
  `yUndoManagerKeymap` in collaboration. Critical **[V]**: `ySync` is a `ViewPlugin`, so the
  `EditorState`s stored in `states` for hidden files do not receive remote edits — rebuild the
  state from the `Y.Text` when switching files (or apply the diff before `setState`), and keep one
  `UndoManager` per `Y.Text` outside the state. The external-change subscription (~lines 92–115)
  replaces the whole document (`changes: { from: 0, to: length }`) and must be disabled for linked
  documents.
- `src/session.ts`: in collaboration no `part_save` / `project_save` for CRDT files (`setPart` only
  updates the UI store); `createPart`, `deletePart`, `movePart`, `splitPart`, `mergeWithNext` become
  `structure_op` messages to the host; `runCompile` and `MAX_RERUNS` move to the host.
- `updateMeta` (`src/components/sidebar/PaperPanel.tsx`, `src/components/TemplateGallery.tsx`) and
  `setBib` (`src/components/Workspace.tsx`, which today appends by rewriting the whole bib **[V]**)
  become `Y.Map`/`Y.Text` operations; title and abstract use a common prefix/suffix diff.
- `src/store.ts`: `collab: { role, peers, connection }`. `src/components/sidebar/StructurePanel.tsx`:
  avatars per `PartCard`.
- Optional desktop guest with a Rust replica: its backend holds `yrs`, connects to the host and
  talks to its webview over IPC — no CSP change, disk persistence, local compile.

Protocol sketch **[S]**:

```text
WS /collab   → {auth: token} → {hello: role, sessionId, epoch}
sub/unsub <room>  ·  <room> y-sync step1/step2/update  ·  <room> awareness
ctl: structure_op{op,args} → structure_result{snapshot}
ctl: compile_status{state} · pdf_ready{version, ms} · diagnostics{…} · toc{…} · figures_changed
HTTP (token): GET /collab/pdf?v=N · GET/POST /collab/figures/*
```

Compilation:

- The host compiles: `flush_all()` then `compiler::compile`. The content-hash fragment cache
  (`cache_key`, `run_cached` in `compiler.rs` **[V]**) keeps reconverting only changed parts.
- Change `Backend::compile` in `backend.rs`: today a new request aborts the running compile
  (`running.replace(...).abort()` **[V]**). With several people typing nonstop no compile would
  finish **[S]**. Instead: one compile at a time; changes during a compile mark it dirty and
  trigger one more when it ends; global debounce ~400 ms with a ~2 s max wait.
- Broadcast `pdf_ready`, diagnostics and TOC (`CompileOutcome`); guests download the PDF.
  Diagnostics already carry `part` (`Diagnostic.part` in `src/lib/api.ts` **[V]**).
- Focus mode is per user (`previewFocus` in localStorage, `compileFocus` in `session.ts` **[V]**),
  and `includeonly` is part of the main document's cache key (`convert_main` **[V]**), so
  alternating foci would cause cascading recompiles **[S]**. Proposal: the shared PDF is always the
  full preview; focus is only available to a desktop guest compiling locally on its replica.

Presence: `yCollab` draws named remote cursors and selections from awareness `cursor`; relative
positions survive concurrent edits **[V]**; the host clears a disconnected user's awareness
**[V]**. Session awareness `{user: {name, color}, file, following?}` shown in `StructurePanel.tsx`.
Follow mode via `jumpTo` / `openFile` in `src/store.ts`. Comments later: `Y.Map` per part anchored
with relative positions, shown as CodeMirror decorations (decide whether to materialize to
`.paperforge/comments/*.json`).

Tests: Rust `#[tokio::test]` in `collab/` — N in-process `yrs` docs exchanging `DefaultProtocol`;
the real server with `tokio-tungstenite` clients; materializer without loops and disk diff; token
and `Origin` rejected; room-name path traversal rejected; split/merge with concurrent edits. Node:
two Yjs clients against `paperforge-web` (pattern: `/tmp/pf-collab/js/two-clients.mjs`). Playwright:
two contexts with visible remote cursors, and extend `typingCost` in `e2e/ui-check.mjs` to
collaboration mode.

Prototype measurements **[V]**:

| Test | Result |
|---|---|
| Keystroke A → B over loopback via the `yrs` host | p50 0.31–0.36 ms, p95 0.51–3.14 ms |
| Update size per keystroke | 24 bytes |
| External `.md` edit | 1 op, reaches both guests |
| Offline merge / fake token | converge / `wsconnected: false` |

| Part size | Plain (today) p50/p95 | Yjs local p50/p95 | Apply remote update p50/p95 |
|---|---|---|---|
| 7.5K chars | 0.1 / 0.4 ms | 0.1 / 0.5 ms | 0.1 / 0.2 ms |
| 145K chars | 0.4 / 0.7 ms | 0.4 / 0.7 ms | 0.3 / 0.5 ms |

(300 keystrokes in headless Chrome, same method as `e2e/ui-check.mjs`, 0.1 ms clock resolution.)

## Phases

| Phase | Content | Effort |
|---|---|---|
| 0 | Decide Yjs vs soft lock; TLS policy; solo mode as a "session of one"? | S |
| 1 | Rust core `collab/`: rooms, materializer, watcher, `.bin`, host-only seeding, in-process tests | M |
| 2 | Network: LAN listener, multiplexing, token and `Origin`, `collab_start/stop`, URL/QR, CSP | M |
| 3 | Frontend: provider, `Editor.tsx` with `yCollab` (hidden states, undo), collaboration mode in `session.ts`, meta and bib as CRDT | L |
| 4 | Shared compile: starvation-free scheduler; PDF, diagnostics, TOC broadcast | M |
| 5 | Structure ops on the CRDT with freeze; concurrent tests | M |
| 6 | Presence UI (avatars, follow), mDNS, IndexedDB offline, epochs and compaction, git interface | M |
| 7 | Optional: comments, self-signed TLS, desktop guest with Rust replica and local focus compile | L |

## Risks and open questions

Risks: edits lost during split/merge (mitigated by the freeze, untested); compile starvation unless
the abort policy in `backend.rs` changes; two save paths (solo vs collaboration) while both exist;
`.bin` growth on long documents and epochs on compaction with offline guests; Yjs 14 beta; no TLS on
shared networks and no secure context over `http://IP`; room-name path traversal if not validated;
unverified macOS local-network permissions, Windows firewall prompts and real IndexedDB behavior.

Open questions:

- When the host leaves, the session ends and guests keep offline copies — is host handover needed?
- Browser-only guests acceptable, or must guests run the desktop app?
- Should comments be versioned in git?
- Allow renaming parts? Today the path is the room id; renaming needs stable ids.
- Who may run git checkout/pull during a session?

The research prototypes (`yhost/`, `js/two-clients.mjs`, `bench/`) are in `/tmp/pf-collab/` and are
not part of the repository.
