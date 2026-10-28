# Implementation plan: Word-like editing, executed by subagents in batches

Source: `01-word-like-editing.md` (features 1–16). This document only decides **who does what,
in which order, and how each piece is verified**. Design details stay in the source plan.

## Execution model

- **Orchestrator** (the main agent) owns an integration branch `feat/word-like` cut from `main`.
- Each task runs in a **`best-of-n-runner` subagent** (own git worktree and branch
  `wl/<batch>-<task>`), started from the current tip of `feat/word-like`.
- Tasks inside a batch run **in parallel**; a batch starts only when the previous one is merged
  and green.
- After a batch the orchestrator merges the task branches **one by one** into `feat/word-like`,
  resolves conflicts, runs the full gate, and fixes integration breakage before the next batch.
- One task = one feature (or a few small related ones) = one reviewable commit series.

### Conflict hot spots (orchestrator resolves on merge)

| File | Why it conflicts |
|---|---|
| `src-tauri/src/lib.rs` (`generate_handler!`), `backend.rs` (command `match`), `bin/paperforge-web.rs`, `src/lib/platform.ts`, `src/lib/api.ts` | Every new backend command is registered in all of them. Agents append new entries at the **end** of each list to keep conflicts trivial. |
| `src-tauri/src/compiler.rs` | Features 1, 4, 7, 11, 12. Batches are arranged so that at most two tasks touch it at once, in different functions. |
| `src/editor/extensions.ts` | Features 3, 5, 8, 10, 16. New code goes into new modules; `extensions.ts` only gets a one-line registration. |
| `src-tauri/src/project.rs` (`PaperMeta`) | Features 7, 11, 12. New fields are `#[serde(default)]` and optional. |
| `package-lock.json`, `Cargo.lock` | Never hand-merged: take one side, then rerun `npm install` / `cargo build`. |

### Gate (every task, then again after each merge)

1. `npm run build` (type check + Vite build).
2. `npm test` (`vitest run` + `cargo test --lib`).
3. If LaTeX output changed: `npm run test:toolchain` (warms the offline cache; needs network the
   first time for new packages).
4. If UI or editor changed: `node e2e/make-fixture.mjs /tmp/pf-multipart` once, then
   `node e2e/ui-check.mjs /tmp/pf-multipart /tmp/pf-out`. **`typingCost` p50 must not regress by
   more than 20% over the baseline recorded in batch 0** (today ~0.2 ms).
5. Hard rule from the source plan: every edit is a local text change in the Markdown; nothing
   re-serializes a whole part. Reviewers reject any task that breaks it.

### Standard subagent prompt

```
Repository: paperforge, branch <wl/...> from feat/word-like.
Read docs/plans/01-word-like-editing.md, section <N>, and docs/plans/01-word-like-editing-implementation.md, task <ID>.
Implement exactly the scope of task <ID>; do not touch files owned by other tasks of this batch
(listed in the task) except for appending registrations at the end of shared lists.
All code, comments, UI strings and docs in English. Match the surrounding code style.
Add tests: Rust unit tests next to the code, frontend tests with vitest.
Run the gate (build, npm test, toolchain/e2e when applicable) and report: files changed,
tests added, gate results, typingCost p50 if measured, open issues.
Commit on your branch; do not merge.
```

## Decisions to confirm before the batch that needs them

| Decision | Default proposed | Needed by |
|---|---|---|
| Hunspell dictionaries license | Bundle `dictionary-en` and `dictionary-es` under their MPL option, with license notices in `THIRD_PARTY.md` | Batch 1, task 1C |
| Reference prefix | Insert localized text ("Figure", "Figura") from `meta.language`; no `cleveref` (not cached) | Batch 2, task 2A |
| Comments storage | Inline Pandoc spans `[text]{.comment author=… date=…}` (portable, no drifting anchors) | Batch 5, task 5A |
| Track changes scope | Spans + accept/reject now; "compare with version X" only if `02-git-versioning.md` has landed | Batch 6 |

## Batch 0 — Preparation (orchestrator, sequential)

- Create `feat/word-like`; confirm the gate is green on `main`.
- Build the e2e fixture and record the baseline `typingCost` p50/p95 in this document.
- No subagents.

Baseline on `feat/word-like` (2026-10-28): one part (13 lines) p50 0.20 ms, p95 0.50 ms;
20x part (286 lines) p50 0.20 ms, p95 0.50 ms; no long tasks. `PF_URL` overrides the e2e URL so
parallel worktrees can each run Vite on their own port.

## Batch 1 — Foundations without shared backend logic (4 in parallel)

| ID | Feature | Owns | Shared (append only) |
|---|---|---|---|
| 1A | **1. SyncTeX + block markers** | `compiler.rs` (`tectonic`, `run` stdin, `pandoc_fragment`, `PANDOC_ARGS_VERSION`), `paper.lua`, new `synctex.rs`, `Preview.tsx` (double click, `revealCursor`), `diagnostics.ts`, `Cargo.toml` (`flate2`) | registries |
| 1B | **2. Find/replace across parts** | new `src/components/sidebar/FindPanel.tsx`, new `src/editor/findAcrossParts.ts`, `Editor.tsx` (apply replacements as transactions on stored `EditorState`s), `Sidebar.tsx`, `store.ts` | — |
| 1C | **3. Offline spell check** | new `src/editor/spell/` (worker, `nspell`, lint source that skips math/code/citations/attributes/raw LaTeX), `package.json`; personal dictionary `.paperforge/dictionary.txt` via a new command in `project.rs` | `extensions.ts` (one line), registries |
| 1D | **5. Paste image + figure inspector** | `Workspace.tsx` paste handling, new `src/components/FigureInspector.tsx`, `FiguresPanel.tsx`, `project.rs` (`import_figure_bytes`) | `extensions.ts` (one line), registries |

Acceptance highlights:
- 1A: tests that marked and unmarked fragments are identical apart from `%PF:N` comments; lists
  (tight and loose), indented code and fenced blocks are never split; PDF double click lands on the
  exact Markdown line; editor → PDF jump works across `\input` parts.
- 1B: replace-all is undoable per part and keeps the undo history of open parts; "skip
  math/code/citations" covered by vitest.
- 1C: no main-thread blocking (worker); language from `meta.language`; typingCost gate.
- 1D: pasted PNG lands in `figures/` and inserts `![caption](figures/x.png){#fig:x width=…}`; the
  inspector edits only the attribute span of that one figure.

## Batch 2 — Compile-side metadata and independent panels (4 in parallel)

| ID | Feature | Owns | Shared |
|---|---|---|---|
| 2A | **4. Cross references with numbers/pages** | `compiler.rs` (`read_aux_tree`: parse `\newlabel`, return `label → (number, page)` with the compile result), `citationCompletions` in `extensions.ts`, reference picker inserting the localized prefix | registries |
| 2B | **7. Preamble, class options, ejectable template** + **16. footnote button** | `project.rs` (`PaperMeta`: preamble, class options), `compiler.rs` (`pandoc_metadata` fills `header-includes`; `compile()` accepts a project-local template), `resources/templates/*.tex` (`$classoption$`), `PaperPanel.tsx`, `Toolbar.tsx` (`GROUPS` gets the footnote action) | registries |
| 2C | **6. Bibliography: DOI/arXiv, Zotero watch** | new `src-tauri/src/bibfetch.rs` (HTTP client crate), `notify` watcher, `ReferencesPanel.tsx`, `src/lib/bib.ts`, `Cargo.toml`, `package.json` (BibTeX parser) | registries |
| 2D | **16. Outline folding, word goals** | `extensions.ts` `base()` (`foldGutter` + Markdown fold service), `StatusBar.tsx` (goal from `PaperMeta` or local settings) | — |

Notes: 2A and 2B both edit `compiler.rs` but in different functions; 2B and 2D both touch the
toolbar/status area only lightly. 2C must keep everything offline-first and route network through
Rust (the CSP stays unchanged).

## Batch 3 — Writing mode core + layout/styles backend (3 in parallel)

| ID | Feature | Owns | Shared |
|---|---|---|---|
| 3A | **8. Writing mode (live preview)** | new `src/editor/livepreview/` (Lezer extensions for attributes, `$$`, citations, divs, `{=latex}`; widgets for KaTeX, figure thumbnails, citation chips, reference chips from 2A, headings), `Compartment` toggle in `Editor.tsx`, switch in `Toolbar.tsx` | `extensions.ts` |
| 3B | **11. Page setup** | `PaperMeta.layout`, template variables in `article`/`report`/`book` (remove hard-coded `geometry`), new `PageSetupPanel.tsx`; "set by the journal" for IEEE/ACM/LNCS/Elsevier | `compiler.rs` `pandoc_metadata` |
| 3C | **12. Paragraph/character styles** | `paper.json` style map, preamble injection (reuses 2B), style picker that shows the LaTeX, Lua mapping of divs/spans in `paper.lua` | `compiler.rs` `pandoc_metadata` |

Notes: 3A is the critical path (L effort); it exposes a small widget registry in
`src/editor/livepreview/index.ts` so batch 4 adds widgets without editing each other's files.
3B and 3C both add `PaperMeta` fields and template variables: merge 3B first. Uncached packages
(`setspace`, `lineno`) go through `needs_network`; run `npm run test:toolchain` after merging.

## Batch 4 — Widgets on top of Writing mode (3 in parallel)

| ID | Feature | Owns |
|---|---|---|
| 4A | **9. Visual table editor** | `src/editor/livepreview/table/` grid widget that rewrites only the table's own text range as an aligned pipe table with caption and label. Merged cells (rewriting `Table()` in `paper.lua`) are out of scope for this batch. |
| 4B | **10. Equation editor (MathLive)** | `src/editor/livepreview/math/` popover on `$…$`/`$$…$$`; writes back only on a real edit; `package.json` (`mathlive`). |
| 4C | **13. "Show LaTeX" + convert to raw LaTeX + generated-tab sync** | popover using the `%PF:N` map from 1A, "convert block to ```` ```{=latex} ````", generated LaTeX tab follows the editor and click-jumps back; `backend.rs` `flatten_tex` keeps the markers mapping. |

Each registers through the 3A widget registry only. Gate includes typingCost on a long document.

## Batch 5 — Review features (2 in parallel)

| ID | Feature | Owns |
|---|---|---|
| 5A | **14. Comments + review PDF** | comment spans, sidebar comment list, review PDF mode (`soul`/`xcolor`, cached) in `paper.lua` and `compiler.rs` (a `review` compile flag); the final PDF strips comments. |
| 5B | **16. Grammar (harper.js)** | `src/editor/grammar/` WASM worker, lint source (English only at first), toggle in settings. |

## Batch 6 — Track changes (1 task, sequential)

| ID | Feature | Owns |
|---|---|---|
| 6A | **15. Track changes, stage 1** | `[x]{.insertion}` / `[x]{.deletion}` spans, accept/reject commands, rendering in the review PDF from 5A. "Compare with version X" only if `02-git-versioning.md` is merged; otherwise it is a follow-up. |

## Final integration (orchestrator)

- Full gate on `feat/word-like`, plus `node e2e/web-check.mjs` for browser mode.
- `npm run warm-tex-cache` so every new package is cached offline.
- Update `01-word-like-editing.md` markers from **[S]** to **[V]** where implementation confirmed
  them, then open one PR per batch (or one PR for the branch) against `main`.

## Summary

| Batch | Parallel tasks | Features | Depends on |
|---|---|---|---|
| 0 | — | setup, baseline | — |
| 1 | 4 | 1, 2, 3, 5 | 0 |
| 2 | 4 | 4, 6, 7, 16 (footnote, folding, goals) | 1 (2A uses 1A's compile result shape) |
| 3 | 3 | 8, 11, 12 | 2 (chips need 4; 11/12 need 7) |
| 4 | 3 | 9, 10, 13 | 3 (widget registry), 1 (markers) |
| 5 | 2 | 14, 16 (grammar) | 3 |
| 6 | 1 | 15 | 5, optionally plan 02 |
