# Version history

PaperForge keeps a Word/Google Docs–style history of every paper: it saves in the background
while you write, keeps versions at milestones, compares any two of them word by word, and
restores the whole paper or a single part. Underneath it is a plain git repository in the project
folder, so the history also works with `git`, GitHub or GitLab.

Design and later phases: `plans/02-git-versioning.md`. What was built, and by whom:
`plans/02-git-versioning-implementation.md`.

## For writers

**Turning it on.** New projects start with history on (first version: "Project created").
Projects created before this feature show an **Enable version history** banner in the
**History** tab. "Save version" also turns history on.

**What gets saved, and when.**

| When | What | Shown as |
|---|---|---|
| 2 minutes after you stop typing; every 10 minutes while you keep typing | autosave | grey dot, folded ("12 autosaves") |
| Before deleting, splitting or merging parts, and before a restore | autosave with the reason ("Before deleting “Method”") | grey dot |
| **Save version** (toolbar, Cmd/Ctrl+Shift+S), optionally with a name and a note | version, named when you give a name | bold, with a label chip |
| After exporting a PDF, a review PDF or the LaTeX sources | version "PDF exported" | bold |
| When you close the project or open another one, if the paper changed | version "Session 28 Oct 10:02–12:30" | bold |
| After restoring | version "Restored the version of 28 Oct 10:02" | bold |

Nothing is recorded when nothing changed. Saving a named version without changes names the last
version instead.

**Reading the timeline.** The History tab groups entries by day ("Today", "Yesterday",
"28 Oct"). Each entry has a summary written from the changes ("Edited: Introduction, Method ·
Added: Results · Title changed"). The status bar shows "Last version 14:02"; click it to open the
tab.

**Comparing.** Click an entry to see what it changed since the entry before it, or use
**Compare with current** in its menu. The compare view covers the editor (Esc closes it): one
card per changed part with insertions in green and deletions struck through, long unchanged
stretches folded ("Show 41 unchanged words"), then paper settings ("Title: “A” → “B”", "Part
added: Results"), references by citation key, and other files such as figures.

**Restoring.** **Restore this version…** brings the whole paper back; **Restore this part** on a
card brings one part back, and adds it again if it was deleted since. Nothing is lost: the
current text is kept as an autosave first, so a restore can itself be undone from the timeline.
Autosaves cannot be named; restore one and save a version to keep it.

## For git users

The project folder is an ordinary repository:

```text
refs/heads/main                   versions: one commit each, parent = the previous version
refs/paperforge/autosave/main     autosaves: a hidden linear chain
refs/tags/<slug>                  named versions: annotated tags (message = name, blank line, note)
```

- `git log` shows only versions; `git log --all` also shows autosaves. `git push` does not
  publish autosaves and `git clone` does not fetch them.
- Right after a version `git status` is clean. Autosaves do not touch `.git/index`, so
  `git status` shows what changed since the last version.
- Commit messages end with trailers PaperForge reads back:

  ```text
  Edited: Introduction, Method · Added: Results · Title changed

  PaperForge-Kind: version
  PaperForge-Changed: sections/introduction.md, sections/method.md, paper.json
  ```

  Commits you make yourself (no trailers) appear as versions; your own tags appear as names.
- Enabling history writes or completes `.gitignore` (`.build/`, `*.tmp~`, OS clutter) and
  `.gitattributes` (LF line endings, `diff=markdown`/`diff=bibtex`, binary images and PDFs).
  Missing lines are appended under a `# PaperForge` header; your own rules are kept.
- PaperForge marks its repositories with `paperforge.enabled = true` (and `paperforge.adopted =
  true` for a folder that already was a repository) in `.git/config`. Without the flag it never
  writes to a repository. A project inside another repository is not supported yet.
- Commits are signed with your git `user.name`/`user.email`, else the paper's first author, else
  "PaperForge". PaperForge never writes identity into your config.

## For developers

### Layers

```text
src/history.ts, components/sidebar/HistoryPanel.tsx,      scheduling, timeline, compare view
components/HistoryDiffView.tsx, SaveVersionDialog.tsx
        │  api.history* (src/lib/api.ts)
src-tauri/src/backend.rs  Backend::dispatch               project lock, autosave hooks, spawn_blocking
        │
src-tauri/src/history/    mod.rs   types, public API, shared helpers
                          repo.rs  enable/adopt, status, identity, .gitignore/.gitattributes
                          snapshot.rs  autosave, save_version, summaries and trailers
                          log.rs   timeline, paging, names (tags)
                          restore.rs  read_part, restore, restore_part
                          diff.rs, bib.rs  word diff, paper.json and refs.bib in plain language
```

The engine is `git2` 0.21 with a vendored libgit2 (no system git needed). Only the
`vendored-libgit2` feature is on; the remote phase adds `https` and `ssh`.

### Commands

| Command | Returns |
|---|---|
| `history_status(dir)` | `HistoryStatus { enabled, mode: own\|adopted\|parentRepo\|none, branch, dirty, lastVersion, remote }` |
| `history_enable(dir)` | `HistoryStatus` |
| `history_autosave(dir, reason?)` | `VersionInfo` or null (history off, or nothing changed) |
| `history_save_version(dir, label?, note?, reason?)` | `VersionInfo` or null (nothing changed, nothing to name) |
| `history_list(dir, includeAutosaves, before?, limit)` | `VersionInfo[]`, newest first; `before` = id of the last entry shown |
| `history_label(dir, id, label?)` | `VersionInfo`; null label removes the name; versions only |
| `history_diff(dir, from, to?)` | `VersionDiff`; `to` null = the working copy |
| `history_read_part(dir, id, file)` | the file's text in that snapshot |
| `history_restore(dir, id)` / `history_restore_part(dir, id, file)` | `ProjectSnapshot` |

Like every command, each one is registered in `Backend::dispatch` + `COMMANDS`, in
`generate_handler!` (`lib.rs`) and in `src/lib/api.ts`. The desktop handlers of write and history
commands delegate to `Backend::dispatch`, so locking and hooks exist in one place.

### Rules the engine keeps

- **One project lock.** `Backend` holds a `tokio::Mutex` per project folder; every write command
  and every history command runs under it (`LOCKED` in `backend.rs`), so a snapshot never sees
  half of a multi-file change such as a split. git work runs in `spawn_blocking`.
- **One repository per operation.** `git2::Repository` is not `Sync`; each function opens it
  with `open_repo`, which only accepts a repository at the project folder itself.
- **Trees from the working copy** come from `worktree_tree(repo, write_index)`: `add_all` +
  `update_all` honoring `.gitignore`. Versions pass `true` (`.git/index` written), autosaves and
  the diff against the working copy pass `false`.
- **No empty snapshots.** An autosave is compared with the newest snapshot (autosave tip or
  branch tip); a version with the branch tip.
- **Monotonic times.** A snapshot is stamped now, or one second after the newest snapshot when the
  clock has not moved past it, so "Before restoring…" and "Restored…" always sort correctly.
- **Hooks before destructive commands.** `part_delete`, `part_split` and `parts_merge` take an
  autosave first; if that snapshot fails, the command fails rather than lose text unrecorded.
  `project_create` enables history; a failure there does not block creating the project.
- **Restore order.** Files are written through the project writers (`write_part`,
  `write_atomic`), `paper.json` last (`open()` drops parts missing on disk). Files absent from
  the target are deleted only if they are in the autosave just taken, so they stay recoverable.
  Restoring a state identical to the last version records only the "Before restoring…" autosave.
- **Diff.** Parts are `.md` files listed in either side's `paper.json` or under `sections/`;
  renames are detected with `find_similar`. The word diff tokenizes into words, whitespace runs
  and single other characters (so `**`, `#`, `[@key]` never glue to a changed word), runs
  `similar` with a 1 s deadline per part, and returns the whole text as equal/insert/delete runs;
  the UI folds long equal runs.

### Frontend

- `src/history.ts` schedules autosaves from `noteSaved()`, which `writePending` calls after a
  successful save — never per keystroke. All history writes go through the session's `serial()`
  queue; restores go through `restructure()`, which flushes pending edits first and keeps text
  typed meanwhile.
- Background snapshots (autosaves, export and session versions) fail quietly; user actions report
  errors.
- History state lives in the store (`historyStatus`, `versions`, `historyMore`, `compare`), but no
  editor component subscribes to it; the compare view is an overlay, so the editor stays mounted
  with its undo history.

### Tests

- Rust (`cargo test --lib`): unit tests next to each `history/*.rs` file on temporary
  repositories, plus `dispatch_round_trips_history` in `backend.rs`.
- `src/lib/history.test.ts`: day grouping, autosave folding, session labels, segment folding.
- `e2e/ui-check.mjs`: History tab, Save version, compare and restore against an in-memory history
  stub; also measures typing cost.
- `e2e/web-check.mjs`: the same round trip against the real backend (`npm run web -- <project>`),
  checking the tag and a clean `git status` with the git CLI.

## Known limits and next steps

- Quitting the desktop app does not record a session version yet (closing or switching projects
  does); autosaves still cover the text. Fix: handle `CloseRequested` in the backend.
- No retention or repack yet: autosaves and `history_status`/compare (which build trees from the
  working copy) add loose objects. Phase F3 thins autosaves (48 h all, 2 weeks hourly, 3 months
  daily) and repacks.
- An adopted repository keeps files it already tracked, even if now ignored (e.g. a committed
  `.build/`); F3 offers to untrack them.
- `PaperForge-Changed` separates paths with ", ", so a path containing a comma would be split.
- Later phases: remotes and sync with GitHub/GitLab (F4), one-way publish to Overleaf (F5),
  compare PDFs (F6), draft variants as branches (F7).
