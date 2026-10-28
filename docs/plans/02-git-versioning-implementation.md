# Implementation plan: git versioning, executed by subagents in batches

Source: `02-git-versioning.md`. Scope of this round: phases **F0, F1 and F2** (local history,
compare, restore one part, milestones, versions on export and close). F3–F7 (retention and repack,
adopting existing repositories fully, remotes, Overleaf, PDF compare, draft variants) are later.

## Execution model

Same as `01-word-like-editing-implementation.md`: the orchestrator owns `feat/git-versioning`;
each task runs in a `best-of-n-runner` subagent (own worktree, branch `gv/<task>`) cut from the
tip of `feat/git-versioning`; tasks of a batch run in parallel; the orchestrator merges them one by
one and runs the gate.

### Gate

1. `npm run build` (type check + Vite build).
2. `npm test` (`vitest run` + `cargo test --lib`), with no new compiler warnings.
3. UI tasks: `node e2e/make-fixture.mjs /tmp/pf-multipart` once, then
   `node e2e/ui-check.mjs /tmp/pf-multipart /tmp/pf-out` (no page errors, typing p50 not worse).

## Batch 0 — Foundations (orchestrator, done)

- `git2 0.21` with `vendored-libgit2` only (no `https`/`ssh`/OpenSSL until the remote phase) and
  `similar 3` in `src-tauri/Cargo.toml`.
- `paper.json` ends with a newline; `write_meta`, `write_part`, `read_optional`,
  `remove_optional`, `check_part_path` and `atx_heading` are `pub(crate)` in `project.rs`.
- `src-tauri/src/history/mod.rs`: every serializable type (`HistoryStatus`, `VersionInfo`,
  `VersionDiff`, …), the public API as thin wrappers, and shared helpers: `git_err`, `open_repo`,
  `resolve_commit`, `worktree_tree(repo, write_index)` (tree from the working copy honoring
  `.gitignore`; `.git/index` untouched unless asked) and `part_title(content, file)`.
- Stub submodules `repo.rs`, `snapshot.rs`, `log.rs`, `restore.rs`, `diff.rs`: `status` reports
  "not enabled", `autosave` returns `Ok(None)`, the rest return an error.
- `backend.rs`: ten `history_*` commands in `dispatch` and `COMMANDS`; one `tokio::Mutex` per
  project folder held by every write and history command (`LOCKED`); git work runs in
  `spawn_blocking`; `part_delete`, `part_split` and `parts_merge` record an autosave first
  ("Before deleting “Method”"); `project_create` enables history with "Project created".
- `lib.rs`: write and history commands delegate to `Backend::dispatch`, so the lock and hooks
  exist once. `src/lib/api.ts`: `api.history*` functions and the TypeScript types.

## Batch 1 — Engine, diff and UI (3 in parallel)

| ID | Owns | Must not touch |
|---|---|---|
| 1A engine | `history/repo.rs`, `snapshot.rs`, `log.rs`, `restore.rs`, new private helper files under `history/` (append their `mod` line in `mod.rs`) | `diff.rs`, frontend |
| 1B diff | `history/diff.rs` (and private helper files it needs, e.g. `history/bib.rs`) | the other `history/*.rs`, frontend |
| 1C UI | everything under `src/` except `src/lib/api.ts` (read-only; report needed changes) | `src-tauri/` |

Shared contract: the types and signatures in `history/mod.rs` and `src/lib/api.ts`. Changing them
is an orchestrator decision; a task that needs a change reports it instead.

### 1A — History engine (F1 + milestones + restore part)

- **repo.rs** `status`: no repository at `dir` → `mode: none`; `Repository::discover` finding a
  repository whose workdir is not `dir` → `parentRepo` (disabled); own repository → `own` when
  `.git/config` has `paperforge.enabled = true` and `paperforge.adopted` unset, `adopted` when
  adopted. `branch`, `dirty` (worktree tree ≠ HEAD tree), `lastVersion`, `remote` (`origin` URL).
- `enable(dir, summary)`: refuse `parentRepo` with a clear message; `init` with initial branch
  `main`, or adopt an existing repository (set `paperforge.adopted = true`); write `.gitignore` and
  `.gitattributes` (content in the source plan) or append the missing lines under a `# PaperForge`
  header; set `paperforge.enabled = true`; record a first version with `summary` (an adopted
  repository with an unchanged tree gets no commit). Enabling twice is a no-op returning status.
- Identity: `user.name`/`user.email` from git config, else the first author of `paper.json`
  (empty email → `paperforge@localhost`), else "PaperForge". Never write identity to config.
- **snapshot.rs** `autosave`: history off → `Ok(None)`. Tree via `worktree_tree(repo, false)`;
  compare with the newest snapshot (autosave tip or HEAD, whichever is newer); unchanged → `None`.
  Commit on `refs/paperforge/autosave/<branch>`, parent = autosave tip, else HEAD. `.git/index`
  and the branch never move.
- `save_version(label, note, reason)`: tree via `worktree_tree(repo, true)`; unchanged vs HEAD →
  with a label, tag HEAD and return it; without, `None`. Otherwise commit on HEAD's branch (parent
  = HEAD; handle the unborn first commit). A label adds an annotated tag `refs/tags/<slug>`
  (unique `-2`, `-3` suffix; tag message = label, blank line, note).
- Messages: first line = `reason` when given, else automatic from the tree diff against the
  parent: `Edited: Introduction, Method · Added: Results · Deleted: Old · Title changed ·
  References changed · Figures changed` (parts named by `part_title`; `paper.json` reports
  "Title changed" or "Paper settings changed"; at most 3 names per list, then "+N more"). Then a
  blank line and trailers `PaperForge-Kind: autosave|version` and
  `PaperForge-Changed: <comma-separated paths>`.
- `VersionInfo` from a commit: kind from the trailer (commits without trailers on the branch are
  versions), `changedParts` from the trailer, else from the diff with the first parent; label and
  note from annotated tags pointing at it (label = first line of the tag message).
- **log.rs** `list`: first-parent walk of HEAD (versions) and of the autosave ref (autosaves,
  stopping at the first commit that is not an autosave), merged newest first, `before` = id of the
  last entry already shown (exclusive), `limit` entries. `label(id, label)`: versions only (an
  autosave → error "Only versions can be named: restore it and save a version"); `None` deletes
  the tags pointing at it.
- **restore.rs** `read_part`: the UTF-8 text of a path in a snapshot (reject paths outside the
  project and binary blobs). `restore(id)`: autosave "Before restoring the version of <when>",
  write every file of the target tree (parts through `project::write_part`, others with
  `project::write_atomic`, `paper.json` last), delete tracked files absent from the target, then
  save a version "Restored the version of <when>" and return `project::open(dir)`.
  `restore_part(id, file)`: `check_part_path`; autosave first; write the part; when it is not in
  the current `meta.parts`, insert it after the nearest part that precedes it in the target
  version's `paper.json` (else first), `write_meta`; save a version "Restored “<title>” from the
  version of <when>"; return `project::open(dir)`.
- `<when>`: "28 Oct 10:02" from the commit time and its own offset, with the year when it is not
  the current year. No new date crate.
- Tests (tempfile): `.build` and `*.tmp~` ignored; autosave moves neither the branch nor
  `.git/index`; unchanged autosave → `None`; a version leaves `repo.statuses()` empty; enable twice;
  parent repo refused; save version with label on an unchanged tree tags HEAD; list ordering and
  `before` paging; label/unlabel; restore round-trips added/deleted parts and `paper.json`;
  `restore_part` re-inserts a deleted part in the right place; backend round trip through
  `dispatch` (create → edit → autosave → version → list → restore).

### 1B — Diff engine (F2)

- `diff(dir, from, to)`: resolve with `resolve_commit`; `to = None` → tree from
  `worktree_tree(repo, false)`. Tree-to-tree diff with rename detection (`Diff::find_similar`).
- Parts (`*.md` listed in either side's `paper.json`, or any `*.md` under `sections/`): word diff
  with `similar` (tokenize into words and whitespace runs; `TextDiff::configure().diff_slices` or
  `diff_unicode_words`), merged into `DiffSegment` runs; whole text, unchanged runs included.
  `title` from `part_title`. Order: newer side's `meta.parts` order, then deleted parts.
- `paper.json` semantic diff into `MetaChange`s: title, abstract ("Abstract edited"), authors
  (added/removed/changed by name), keywords, language, date, template, bibStyle, toc/lof/lot,
  tocDepth, classOptions, layout ("Page setup changed"), styles; `parts`: "Part added: <title>",
  "Part removed: <title>", "Order of parts changed". Unparseable JSON → one "Paper settings
  changed" entry.
- `refs.bib`: entries by citation key (`@type{key,` … balanced braces); added / deleted / modified.
- Everything else → `FileChange` (figures, `preamble.tex`, `template/…`, `.gitignore`, …).
- Tests: word diff segments for a sentence edit; added/deleted/renamed part (rename detection);
  diff against the working copy; meta changes (title, parts added/removed/reordered); bib by key;
  binary figure as a `FileChange`. Build fixture repositories directly with git2 in the tests.

### 1C — Frontend (F1 panel + F2 compare + scheduling)

- `src/history.ts`: autosave after 2 min idle following a successful save, at most every 10 min
  while typing (`noteSaved()` called from `writePending` on success); all history writes go through
  the `serial()` queue of `session.ts` (export it); refresh the panel after each snapshot.
  `closeProject()` awaits `historySaveVersion({ reason: "Session 28 Oct 10:02–12:30" })` when the
  status is dirty. After a successful PDF or LaTeX zip export: `{ reason: "PDF exported" }` /
  `"LaTeX exported"`. `restoreVersion` / `restorePart` reuse `restructure()` from `session.ts`.
- `store.ts`: `SidebarTab` gains `"history"`; state `historyStatus`, `versions`,
  `compare: { from: string; to: string | null } | null`.
- `components/sidebar/HistoryPanel.tsx`: history off → "Enable version history" banner
  (`parentRepo` → explanation, no button); timeline grouped by day ("Today", "Yesterday",
  "28 Oct"), versions bold with label chips, consecutive autosaves folded ("12 autosaves"); per
  entry: View changes (compare with the previous snapshot), Compare with current, Restore (confirm
  dialog), Name / Rename (versions only); "Load older" paging.
- `components/HistoryDiffView.tsx` replaces the editor area while `compare` is set: header with
  the two sides and Close; one card per part with `<ins>`/`<del>` word segments, long unchanged
  runs folded to a few words of context with "Show N unchanged words", "Restore this part"; then
  paper settings, references and other files in plain language.
- `Toolbar.tsx`: "Save version" (popover with optional name and note; Cmd/Ctrl+Shift+S).
  `StatusBar.tsx`: "Last version 14:02" (tooltip with the summary), click opens the History tab.
- Pure helpers (day grouping, autosave folding, session label, segment folding) in
  `src/lib/history.ts` with vitest tests. Until the engine lands the backend returns errors; the
  UI must degrade quietly (no toasts from background autosaves).

## Batch 2 — Integration (orchestrator)

Merge 1A, 1B, 1C; full gate; extend `e2e/web-check.mjs` with a history round trip (create, edit,
save version, compare, restore); write `docs/versioning.md` (how it works, for users and
developers); update the source plan's markers and this document's status.
