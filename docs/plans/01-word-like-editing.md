# Plan: Word-like editing with LaTeX control at every moment

Goal: writing a paper should feel as easy as Microsoft Word (formatting, images, tables,
equations, references, page layout) while the user can always see and override the LaTeX, and
the output stays real LaTeX/PDF quality with no lock-in. DOCX import/export is out of scope.

Markers: **[V]** verified by running something during research, **[S]** assumption or design not
yet tested. File paths refer to the repository as of commit `756df5f`.

## Decision: one Markdown source, a "Writing" mode on the same editor

Keep Pandoc Markdown as the only source of truth and add a live-preview mode on the existing
CodeMirror 6 editor (Obsidian/Typora style), plus SyncTeX for exact PDF ↔ source navigation.

Rejected: a rich-text editor (ProseMirror/Tiptap/Milkdown/BlockNote) that serializes the whole
document. Round-tripping our files through Pandoc `markdown → markdown` rewrites them **[V]**:
pipe tables become simple tables, `$$…$$ {#eq:x}` collapses to one line, `^[note]` moves to the
end as `[^1]`, `width=80%` becomes `width="80%"`, raw LaTeX turns into `` `…`{=tex} ``, and
```` ```{=latex} ```` blocks are lost. Tiptap/Milkdown serializers do not know `{#fig:x .wide}`,
`: caption {#tbl:x}`, `[@k, p. 3]` or raw LaTeX. That would break diffs, git history and the
"no lock-in" promise. Reopen only if target users refuse all markup, and then build on Pandoc's
JSON AST with block-local writes (Pandoc 3.13 ships `--server` **[V]**; effort XL).

Rule for every feature below: an edit is always a local text change in the Markdown. Nothing may
re-serialize a whole part.

## Current state (read in code)

- Editor: `src/editor/extensions.ts` (Markdown, KaTeX hover `mathTooltip`, `@` citations,
  labels, `/` slash commands, `\latex` completions, chapter section badges as widgets).
- Preview: `src/components/Preview.tsx`; double-click in the PDF uses fuzzy matching
  (`bestLineInParts`, `src/lib/textmatch.ts`), not SyncTeX. Diagnostics use the same matching
  (`src/lib/diagnostics.ts`).
- Compile: `src-tauri/src/compiler.rs` converts each part with `--from markdown --wrap=preserve`
  and `src-tauri/resources/templates/paper.lua`, then `\input`/`\include` in `paper.tex`. Tectonic
  runs without `--synctex` (`fn tectonic`).

## Features, prioritized

| # | Feature | Value | Effort | Risk |
|---|---|---|---|---|
| 1 | SyncTeX both ways + block markers | High | M | Medium |
| 2 | Find/replace across all parts | High | S/M | Low |
| 3 | Offline spell check | High | M | Low |
| 4 | Cross references with real numbers and pages | High | S/M | Low |
| 5 | Figure inspector + paste image | High | S/M | Low |
| 6 | Bibliography: DOI/arXiv → BibTeX, Zotero file watch | High | M | Medium |
| 7 | Project preamble, class options, ejectable template | High | S/M | Low |
| 8 | Writing mode (live preview) | Very high | L | Medium |
| 9 | Visual table editor | High | M | Medium |
| 10 | Equation editor (MathLive) | Medium/high | M | Medium |
| 11 | Page setup, headers, footers | High | M | Medium |
| 12 | Paragraph/character styles mapped to LaTeX | Medium | M | Medium |
| 13 | "Show LaTeX" per block + convert to raw LaTeX | High | M | Low |
| 14 | Comments (rendered in a review PDF) | High | M/L | Medium |
| 15 | Track changes (start with "compare with version X") | Medium | L | High |
| 16 | Grammar, word goals, outline folding, footnote button | Medium | S–M | Low |

Version history is covered by `02-git-versioning.md`.

### 1. SyncTeX and Markdown ↔ LaTeX traceability

- **[V]** `tectonic --help` lists `--synctex`; with `\input{part-a}`, `paper.synctex.gz` records
  `Input:13:…/part-a.tex` with per-line records.
- **[V]** Pandoc only offers `sourcepos` for `commonmark_x`, and reading our source as
  `commonmark_x` breaks citations, raw LaTeX, `^[…]`, figures and table captions — not usable.
- **[V]** Working alternative: before conversion, insert `<!--pf:N-->` before each top-level block;
  a Lua filter turns it into a `%PF:N` comment in the fragment, giving an exact fragment-line →
  Markdown-line map.
- **[V]** Pitfall: a marker between loose list items splits the list into two `itemize`
  environments. Insertion must skip list continuations and indented/fenced blocks.
- Changes: `compiler.rs` (`tectonic()` adds `--synctex`; `pandoc_fragment` feeds the marked text
  on stdin — `run()` currently sets `stdin(null)`), `paper.lua`, new `src-tauri/src/synctex.rs`
  (gunzip with `flate2`, own parser; the `synctex-parser` crate 0.1.1 is days old with ~40
  downloads **[V]**), new commands in `lib.rs`, `backend.rs` and `bin/paperforge-web.rs`,
  `Preview.tsx` (`onDoubleClick`, `revealCursor`), `diagnostics.ts`.
- Add the marker scheme to the fragment cache key (`PANDOC_ARGS_VERSION`) and test that the
  generated `.tex` is identical with and without markers apart from the comments.

### 2. Find/replace across parts

Today only the per-file `searchKeymap` exists (`extensions.ts`). Add a sidebar "Find" panel:
regex, case, whole word, "skip math/code/citations", results grouped by part, replace one/all.
Pitfall: `src/components/Editor.tsx` drops a part's `EditorState` (and its undo history) when the
part changes from outside — apply replacements as transactions on the stored states instead.

### 3. Offline spell check

Nothing exists today (no `spellcheck` in the code). Options: `nspell` 2.1.5 (MIT) in a Web Worker
with `dictionary-es` / `dictionary-en` 4.0.0 (Hunspell dictionaries, GPL/LGPL/MPL — check the
licensing decision below), or Rust `spellbook` 0.4.2 (MPL-2.0, Hunspell-compatible, faster).
Report misspellings through `@codemirror/lint`; use the syntax tree to skip `$…$`, code,
`@citations`, `{#…}` attributes and raw LaTeX. Language comes from `meta.language`. Personal
dictionary per project (`.paperforge/dictionary.txt`) and per user.

### 4. Cross references with real numbers

`compiler.rs` already reads the `.aux` tree (`read_aux_tree`) but only extracts `\@writefile`.
Also parse `\newlabel{fig:x}{{2}{3}…}` and send `label → (number, page)` to the frontend. Then the
`@` completion (`citationCompletions`) shows "Figure 2 · p. 3", and Writing mode renders chips.
`paper.lua` emits a bare `\ref`, so users type "Figure @fig:x"; a reference picker can insert the
localized prefix. `cleveref` is not in the offline cache **[V]**.

### 5. Figures

Drop (`Workspace.tsx useFileDrop`) and a panel (`FiguresPanel.tsx`) exist; clipboard paste does
not. Add paste (image → `figures/` → snippet) and a figure inspector popover: caption, automatic
label, `width` slider, `.wide` toggle, alt text (Pandoc emits `alt={…}` **[V]**). Allowed formats
are png/jpg/pdf (`project.rs FIGURE_EXTENSIONS`); SVG would need conversion.

### 6. Bibliography

The desktop CSP (`src-tauri/tauri.conf.json`, `connect-src 'self' ipc: …`) blocks frontend
`fetch`, so lookups go through Rust (add an HTTP client crate). DOI: `doi.org` with
`Accept: application/x-bibtex`; arXiv API. Parsing/formatting: `@citation-js/core` 0.9.0 (MIT) or
`@retorquere/bibtex-parser` 12.1.13 (ISC). Zotero: watch a Better BibTeX auto-exported `.bib`
(`notify` 8.2.1). Everything optional and offline-first.

### 7. Preamble, class options, ejectable template

`common.tex` already loops over `$header-includes$`, but `pandoc_metadata` never fills it and
`PaperMeta` has no field for it. Add a project `preamble.tex` (or a meta field) and a
`$classoption$` variable in the templates. "Eject template" copies the template and `common.tex`
into the project; `compile()` currently rejects templates outside `TEMPLATES`.

### 8. Writing mode (live preview)

New `src/editor/livepreview/`: Lezer extensions (`@lezer/markdown` 1.8.1) for attributes, `$$`,
citations, divs and `{=latex}`; widgets for KaTeX math (already a dependency), figure thumbnails
with captions, citation chips (`shortAuthors` in `src/lib/bib.ts`), reference chips (feature 4),
headings with real typography. Syntax shows again on the cursor's line. A single `EditorState`
with a `Compartment` toggles "Writing" / "Source"; the switch goes in `Toolbar.tsx`. Decorations
must stay viewport-bound like `chapterSections`, and the per-keystroke cost measured by
`typingCost` in `e2e/ui-check.mjs` is the performance gate (today ~0.2 ms p50). Risks: cursor and
selection quirks around replaced ranges, cost on long documents.

### 9. Tables

Grid widget that serializes to an aligned pipe table with caption and label. `paper.lua` uses
`to_simple_table`, which loses rowspan/colspan; merged cells require rewriting `Table()`.

### 10. Equations

`mathlive` 0.111.1 (MIT) in a popover on `$…$` / `$$…$$`. Write back only if the user edits,
because MathLive normalizes the LaTeX **[S]**. Preamble macros are unknown to MathLive and KaTeX.

### 11. Page setup

A `layout` object in `PaperMeta` (paper size, margins, font size, line spacing, columns, font,
header/footer, line numbers) passed as template variables. `geometry` is hard-coded today in
`article`, `report` and `book` (`margin=2.5cm`). `geometry`, `fancyhdr`, `multicol` are cached;
`setspace` and `lineno` are not **[V]**. For IEEE/ACM/LNCS/Elsevier the UI says "set by the
journal".

### 12. Styles

Pandoc divs and spans (`::: {.note}`, `[x]{.smallcaps}`) mapped in `paper.json` to a LaTeX
environment/command injected into the preamble. The user picks a style name and can see its
LaTeX.

### 13. LaTeX control at every moment

- "Show LaTeX" popover per block, using the `%PF:N` markers to show that block's fragment lines.
- "Convert to raw LaTeX" replaces the block with ```` ```{=latex} ```` containing that LaTeX
  (Pandoc keeps raw LaTeX inline and blocks: `raw_tex`, `raw_attribute` **[V]**).
- The "LaTeX (generated)" tab (`texExtensions`, `flatten_tex` in `backend.rs`) follows the editor
  scroll and clicking a line jumps to the Markdown, via the same markers.
- Template parameters (feature 7). LaTeX sources export already exists (`Toolbar.tsx`), and a
  project is a plain folder (`project.rs`).

### 14–15. Comments and track changes

Represent them as Pandoc spans in the Markdown (`[text]{.comment author=… date=…}`,
`[x]{.insertion}` / `[x]{.deletion}`). A "review PDF" renders them with `soul`/`xcolor` (cached);
`changes`/`todonotes` are not cached **[V]**. The final PDF strips them. Keystroke-level track
changes is L/high risk; ship "compare with version X" (from the git plan) first.

### 16. Smaller items

Grammar: `harper.js` 3.0.0 (Apache-2.0, WASM; the CSP already allows `wasm-unsafe-eval`), mostly
English **[S]**. Footnote button: `formatting.footnote` exists but is missing from
`Toolbar.tsx GROUPS`. Word goals on top of the `StatusBar.tsx` counter. Outline folding:
`foldGutter` is not enabled in `base()`.

## Roadmap

1. **Foundations:** 1 SyncTeX, 2 find/replace, 3 spell check, 4 real reference numbers, 5 paste and
   figure inspector, 7 preamble/class options, footnote button. Warm the offline cache with any
   new packages (`npm run warm-tex-cache`).
2. **Word experience:** 8 Writing mode, 9 tables, 10 MathLive, 11 page setup, 12 styles,
   13 "Show LaTeX", 6 DOI/Zotero.
3. **Review:** 14 comments, 15 track changes, grammar, ejectable template.

## Risks and open decisions

- Block markers change Pandoc's input: cover lists and indented blocks with tests.
- Packages outside the offline cache (`changes`, `todonotes`, `setspace`, `cleveref`, `siunitx`,
  `lineno`, `enumitem`, `subcaption`, `tikz` **[V]**) need the network the first time;
  `needs_network` handles it.
- Decide: comments as inline spans (portable) or a side JSON (cleaner source, drifting anchors).
- Decide: localized reference prefix inserted in the text, or `cleveref`.
- Decide: shipping Spanish/English Hunspell dictionaries under MPL/LGPL.
- All network features (DOI, LanguageTool) go through Rust to keep the current CSP.
