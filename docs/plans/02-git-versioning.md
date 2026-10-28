# Plan: git as the versioning engine

Goal: non-technical users get Word/Google Docs–style version history (versions, restore, compare,
named milestones such as "sent to reviewer"), while power users keep a real git repository they
can push to GitHub/GitLab, or publish to Overleaf.

Markers: **[V]** verified during research (code read, command run, or prototype in
`/tmp/pf-git-proto`), **[S]** assumption or untested design. Paths refer to commit `756df5f`.

## Engine: git2 0.21 (libgit2 1.9.7), vendored

| | git2 0.21 | gix 0.90 | system git |
|---|---|---|---|
| commit, tree, refs, tags, log | Yes **[V]** | Yes **[V]** | Yes |
| status / add -A honoring `.gitignore` | Yes (`index.add_all`) **[V]** | Build it from `dirwalk`/`status` **[S]** | Yes |
| tree/blob diff, read a file at a version | Yes **[V]** | Yes **[V]** | Yes |
| three-way merge | Yes, diff3 markers **[V]** | APIs exist, untested **[S]** | Yes |
| HTTPS fetch | Yes **[V]** | Yes (reqwest + rustls) **[V]** | Yes |
| **push** | Yes **[V]** (to a local bare repo) | **No** — gix-protocol 0.68 only fetches **[V]** | Yes |
| SSH | libssh2 (agent, keys) **[V]** | via the `ssh` binary **[S]** | Yes |
| gc / LFS | No gc (has `PackBuilder`); no LFS **[V]** | No | Yes |
| Release size (macOS arm64, lto+strip) | 1.3 MB; 4.8 MB with https+ssh+vendored openssl **[V]** | 2.6 MB; 6.8 MB with HTTPS fetch **[V]** | 0, but not guaranteed installed |

The bundle already ships Pandoc (195 MB), Tectonic (54 MB) and a 55 MB TeX cache, so ~5 MB is
irrelevant. libgit2 vendored only needs the `cc` crate, no cmake **[V]**. Linux CI needs
`libssl-dev` or `vendored-openssl`.

```toml
git2 = { version = "0.21", default-features = false, features = ["vendored-libgit2", "https", "ssh"] }
similar = "3"   # word diff
keyring = "4"   # tokens in the OS keychain (remote phase)
```

git2 0.21 has `default = []`, so `https`/`ssh` must be requested explicitly **[V]**. Its API is
blocking and `Repository` is not `Sync`: open the repo per operation and run network calls in
`tokio::task::spawn_blocking`. The system git is at most an optional extra (e.g. `git gc --auto`).

## Version model

- `refs/heads/main` (and branches for "draft variants") holds **versions**: each is a squash
  commit (full tree, parent = previous version), so GitHub history stays clean.
- `refs/paperforge/autosave/<branch>` is a linear chain of **autosaves**. Default `git push` does
  not publish it and a clone does not fetch it; it only shows in `git log --all` **[V]**.
- `refs/tags/<slug>` are **named milestones** (annotated tags with label and note). Only versions
  can be named; an old autosave is offered as "Restore and save as version".

When snapshots happen **[S]**:

| Trigger | Kind |
|---|---|
| 2 min idle after a successful save; at most every 10 min while typing | autosave |
| Before part delete/split/merge, restore, or switching variant | autosave with a reason ("Before deleting “Method”") |
| Project/window close, if changed since the last version | version "Session 28 Oct 10:02–12:30" |
| "Save version" button (optional name) | version (+ tag when named) |
| Successful PDF / LaTeX zip export | version "PDF exported" |
| After a restore | version "Restored the version of …" |

Not on every compile: previews compile after every save (`src/session.ts`) — far too often.

Granularity: the tree is built from the worktree honoring `.gitignore`; an unchanged tree makes no
commit **[V]**. git deduplicates blobs, so a snapshot only adds objects for changed parts.

Index handling: versions write `.git/index` (so `git status` is clean); autosaves are built with an
in-memory index and leave `.git/index` alone, so the CLI shows "changes since the last version"
(` M`, `??`) — the right semantics **[V]**. Writing the index on autosave would show surprise staged
changes **[V]**.

Automatic messages, from the diff, naming parts by their first heading (the `atx_heading` parser
already exists in `src-tauri/src/project.rs`):

```
Edited: Introduction, Method · Added: Results · Title changed

PaperForge-Kind: autosave
PaperForge-Changed: sections/introduction.md, sections/method.md, paper.json
```

Retention **[S]**: keep every autosave for 48 h, then one per hour for 2 weeks, then one per day
for 3 months; versions forever. Thinning rewrites the hidden chain reusing trees and updates the
ref with compare-and-swap. libgit2 has no gc, so a `maintain` step repacks reachable objects with
`PackBuilder::write` (API exists **[V]**, flow untested **[S]**). Without it a thesis with ~10 000
autosaves could reach ~100 MB of loose objects (estimate **[S]**).

## Current code that matters [V]

- Project layout `paper.json`, `sections/*.md`, `refs.bib`, `figures/`, `.build/`
  (`project.rs`). The TeX cache lives in the app data dir, not in the project; `export.zip` is
  staged inside `.build`.
- `write_atomic` writes a sibling temp file `X.tmp~` and renames it — ignore `*.tmp~`.
- `write_meta` uses `to_vec_pretty` (stable field order) without a trailing newline — add `\n`.
- `save()` never touches `meta.parts`; `open()` drops parts missing on disk (`migrate_parts`). A
  restore must write the parts first, then `paper.json`.
- Each command lives in three places: `Backend::dispatch` + `COMMANDS` (`src-tauri/src/backend.rs`,
  used by the browser server), the `#[tauri::command]` + `generate_handler!` in
  `src-tauri/src/lib.rs`, and `src/lib/api.ts`. The `dispatch_knows_every_command` test covers
  new commands.
- All frontend writes go through the `serial()` queue in `src/session.ts`; `restructure()`
  flushes pending edits before a snapshot-returning command and keeps text typed meanwhile — the
  ideal pattern for restore.
- The editor soft-wraps lines (`src/editor/extensions.ts`). The backend has no file watcher.

## Integration design

New Rust module `src-tauri/src/history/` **[S]**:

| File | Responsibility |
|---|---|
| `mod.rs` | Serializable types (`HistoryStatus`, `VersionInfo`, `VersionKind`, `VersionDiff`, `SyncOutcome`) and the public API |
| `repo.rs` | discover/init/adopt, write or complete `.gitignore` and `.gitattributes`, identity (`user.name` from config, else the first author in `paper.json`) |
| `snapshot.rs` | Tree from the worktree via an in-memory index; `autosave`, `save_version`; messages and trailers |
| `log.rs` | Merge `main` and the hidden chain by time, with tags; retention |
| `diff.rs` | Tree diff with rename detection (`find_similar`), word diff with `similar`, semantic `PaperMeta` diff ("Title: A → B", "Part added", "Order changed") |
| `restore.rs` | Restore a version or a single part through `project.rs` writers (`write_part`, `write_meta` become `pub(crate)`) |
| `merge.rs` | Field-wise merge of `paper.json` (three-way on `parts`), `refs.bib` by entry key, the rest via `merge_commits` with markers |
| `remote.rs` | Remotes, fetch, merge, push; credential callbacks (keyring for HTTPS, agent/keys for SSH) |
| `maintain.rs` | Thinning and repack |

Refactor `export_zip` (`project.rs`) into `export_entries(dir) -> Vec<(String, Vec<u8>)>` shared by
the zip and the Overleaf publish.

Commands:

```rust
history_status(dir) -> HistoryStatus          // enabled, mode: own|adopted|parentRepo|none, branch, dirty, lastVersion, remote
history_enable(dir) -> HistoryStatus
history_autosave(dir, reason: Option<String>) -> Option<VersionInfo>   // None = nothing changed
history_save_version(dir, label: Option<String>, note: Option<String>) -> VersionInfo
history_list(dir, include_autosaves: bool, before: Option<String>, limit: usize) -> Vec<VersionInfo>
history_label(dir, id: String, label: Option<String>) -> VersionInfo
history_diff(dir, from: String, to: Option<String>) -> VersionDiff    // to=None → working copy
history_read_part(dir, id: String, file: String) -> String
history_restore(dir, id: String) -> ProjectSnapshot
history_restore_part(dir, id: String, file: String) -> ProjectSnapshot // re-inserts a deleted part
// later phases
history_compile_version(dir, id) -> CompileOutcome   // extract the tree to a temp dir, call compiler::compile
history_branch_create / switch / merge(...)
history_remote_set(dir, url), history_credentials_set(host, user, token)
history_sync(dir) -> SyncOutcome                     // fetch → merge (ff or 3-way) → push main and tags only
history_resolve(dir, resolutions) -> ProjectSnapshot
history_publish_overleaf(dir) -> SyncOutcome
```

`VersionInfo { id, shortId, kind, label?, summary, time, author, changedParts[] }`.

`part_delete`, `parts_merge`, `part_split` and `history_restore*` call
`history::autosave(dir, reason)` first — in both `dispatch` and `lib.rs` (better: make `lib.rs`
delegate to `Backend` so hooks are not duplicated). Add a per-project `tokio::Mutex` in `Backend`
shared by writes and history, so a snapshot never sees a half-written multi-file state.

Frontend **[S]**:

- `src/history.ts`: schedules autosaves; `writePending` calls `noteSaved()` on success;
  `closeProject()` awaits `history_save_version("Session…")`; export `serial()` from
  `session.ts` (or move it to `src/lib/queue.ts`). `restoreVersion`/`restorePart` reuse
  `restructure()`.
- `store.ts`: `SidebarTab` gains `"history"`; state `historyStatus`, `versions`,
  `compare: { from, to } | null`.
- `components/sidebar/HistoryPanel.tsx`: timeline grouped by day, versions bold with labels,
  autosaves folded ("12 autosaves"); actions View, Compare with current, Restore, Name.
- `components/HistoryDiffView.tsx` (replaces the editor area): one card per part with word-level
  `<ins>/<del>` and "Restore this part", plus metadata and bibliography changes in plain language.
- `Toolbar.tsx`: "Save version". `StatusBar.tsx`: "Saved · last version 14:02".
- Later: compare PDFs — compile the old version in a temp dir and show both PDFs side by side
  with a per-page pixel diff (`pdfjs-dist` is already a dependency); optional "redline PDF" from
  `{.ins}/{.del}` spans through a Lua filter (excluding math, tables, code).

Files written into projects **[S]**:

```gitignore
# PaperForge
.build/
*.tmp~
.DS_Store
Thumbs.db
desktop.ini
```

```gitattributes
* text=auto eol=lf
*.md   text eol=lf diff=markdown
*.bib  text eol=lf diff=bibtex
*.json text eol=lf
*.png binary
*.jpg binary
*.jpeg binary
*.pdf binary
```

No Git LFS (libgit2 cannot) **[V]**: warn when a figure exceeds ~25 MB (GitHub rejects > 100 MB).
Do not force one sentence per line; the word diff handles presentation.

Migration **[S]**: new projects (`project::create`) get init, ignore/attributes files and an
initial version "Project created". Existing projects without `.git` show an "Enable version
history" banner. A project with its own `.git` is adopted (complete `.gitignore`; offer to untrack
`.build` if it was committed). A project inside a parent repo: `parentRepo` mode, disabled for now.

Tests: Rust unit tests with `tempfile` — `.build` and `*.tmp~` ignored; autosave moves neither
`main` nor the index; unchanged autosave returns `None`; a version leaves `statuses()` empty;
restore round-trips added/deleted parts; `restore_part` re-inserts a deleted part; rename
detection; semantic merge of `paper.json` and `refs.bib`; retention keeps versions; push/fetch
against a local bare repo (no network, proven **[V]**). Extend `e2e/web-check.mjs`. CI matrix in
`.github/workflows/build.yml` already covers three OSes.

## Phases

| Phase | Content | Effort |
|---|---|---|
| F0 | git2 dependency, ignore/attributes, trailing newline in `paper.json`, per-project mutex | S |
| F1 | Minimal local history: enable/init, autosave to the hidden ref, save version, list, restore all, read part, basic panel | M |
| F2 | Compare (word and metadata diff), restore one part, milestones (tags), versions on export and close | M |
| F3 | Retention and repack, adopting existing repos (identity, dirty index, parent repo), external change detection | M |
| F4 | GitHub/GitLab remotes: keychain token, SSH agent, sync (fetch, merge, push), per-part conflict UI, semantic merges | L |
| F5 | Publish to Overleaf (branch with the exported LaTeX tree, one way) | M |
| F6 | Compare PDFs (compile old version, page diff), optional redline PDF | L |
| F7 | Draft variants (branches): create, switch, merge | M |

## Risks and open questions

- Projects in iCloud/Dropbox/OneDrive folders can corrupt `.git`. Option: keep the repository in
  the app data dir and put a `.git` file with `gitdir: …` in the project (git supports it), at the
  cost of portability.
- Project inside a parent repo: support a subdirectory or disable history?
- External changes while the app is open (e.g. `git checkout` in a terminal) would be overwritten
  today: add a watcher (`notify`) or check mtime/hash before saving.
- Overleaf only accepts a linear `main` **[V]** (official docs; token with user `git`, expires
  yearly). Co-author edits in Overleaf are LaTeX and do not come back to Markdown — is one-way
  publishing enough?
- libgit2: no gc, no LFS, libssh2 lacks FIDO `sk-*` keys **[S]**, SecureTransport is deprecated
  on macOS. Keep the engine behind a trait so reads can move to gix later.
- Linux keyring depends on Secret Service: ask for the token on each sync when absent?
- Should Cmd+S create a version? With autosave that may produce too many; maybe Cmd+Shift+S.
- Privacy: autosaves keep everything ever typed — add "Forget history", and warn that rewriting
  published history is not trivial.
- Conflicts on long single-line paragraphs: add a three-way word merge (`diffy` 0.5) or offer only
  "mine / theirs" per part?

The research prototypes (`g2`, `g2net`, `gx`, `gxnet`) are in `/tmp/pf-git-proto` and are not part
of the repository.
