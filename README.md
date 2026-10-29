# PaperForge

A desktop editor that turns Markdown papers into journal-ready PDFs. Write in Markdown, pick a
template (article, IEEE, ACM, Elsevier, LNCS, report, book) and PaperForge typesets it locally with
Pandoc and Tectonic: no TeX installation, no cloud.

Built with [Tauri 2](https://tauri.app) (Rust backend) and React + CodeMirror 6.

## Features

- **Writing**: Markdown with a live "writing" mode (math, figures, tables and citations rendered in
  place), spell and grammar checking, comments and tracked changes.
- **Papers in parts**: one Markdown file per section or chapter, reordered, split and merged from
  the Structure tab.
- **Typesetting**: instant preview with PDF ↔ source sync (SyncTeX), cross-references,
  bibliographies (BibTeX, DOI/arXiv lookup, Zotero auto-export), exports to PDF, review PDF and
  LaTeX sources for Overleaf or a journal.
- **Version history**: autosaves while you write, named versions, word-by-word compare and
  restore, on a plain git repository. See [docs/versioning.md](docs/versioning.md).
- **Live collaboration on the local network**: up to 10 people edit the same paper at once.

## Collaborating

1. The host opens a paper and clicks **Share** → enters their name → **Start sharing**. PaperForge
   opens port 1440 on that computer and shows a code (`XXXXXX-XXXXXX-XXXXXX`) and a link.
2. Others on the same network either choose **Join a session…** in PaperForge and enter the code,
   or open the link in any browser (the host's computer serves the app; nothing to install).
3. Everyone types at the same time and sees each other's cursors. Edits travel as small CRDT
   updates (Yjs); the host's computer saves the files and typesets the PDF for everyone.

Guests can edit text, references, settings and the structure. Exporting, restoring versions and
opening other projects stay with the host. The first time, the operating system's firewall asks to
allow incoming connections; on Linux with `ufw`, run `sudo ufw allow 1440/tcp`. Traffic is not
encrypted, so share on networks you trust, with people you trust: anyone in the session can write
LaTeX that the host's computer compiles.

Design: [docs/plans/03-local-collaboration.md](docs/plans/03-local-collaboration.md).

## Development

Requirements: Node.js 22+, Rust (stable) and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
npm ci
npm run sidecars          # downloads Pandoc and Tectonic into src-tauri/binaries/
npm run tauri dev         # desktop app with hot reload
```

In a browser instead of the desktop shell:

```bash
npm run web -- <project-dir>   # Rust backend on 127.0.0.1:1430 + Vite on http://localhost:1420
```

Tests:

```bash
npm test                  # vitest + Rust unit tests
npm run test:toolchain    # typesets every template offline against the TeX cache
```

End-to-end checks with a real browser live in `e2e/` (`web-check.mjs`, `ui-check.mjs`,
`collab-check.mjs`); each file explains how to run it.

## Building installers

The `Makefile` builds installers into `release/<target>/`. Run `make` for the list.

| Command | Output | Builds on |
|---|---|---|
| `make mac` | `.dmg` for Apple Silicon and Intel | macOS |
| `make windows` | `.msi` + `.exe` on Windows; `.exe` (NSIS) cross-compiled elsewhere | any |
| `make linux` / `make linux-arm64` | `.AppImage`, `.deb`, `.rpm` | Linux natively; macOS/Windows via Docker |
| `make all` | everything this machine can build | |
| `make ci` | every platform on GitHub Actions | |

Notes:

- The first build warms the TeX cache bundled with the app (`npm run warm-tex-cache`), so papers
  typeset offline. It needs the internet and takes a while; later builds reuse it.
- Cross-compiling for Windows from macOS or Linux needs cargo-xwin, NSIS and LLVM:
  `make windows-tools` installs them. On Windows, GNU Make (e.g. from Git Bash) is enough.
- Linux builds outside Linux run in Docker on Ubuntu 22.04 (`docker/linux.Dockerfile`), like CI.
- Installers are not code-signed yet: macOS Gatekeeper and Windows SmartScreen will warn until they
  are signed (Apple Developer ID with notarization; a Windows code-signing certificate).

CI: [.github/workflows/build.yml](.github/workflows/build.yml) builds all platforms on a `v*` tag
or on demand (`make ci`) and uploads the installers as workflow artifacts.

## Project layout

| Path | What lives there |
|---|---|
| `src/` | React frontend: editor (`editor/`), components, session and saving (`session.ts`), collaboration client (`collab/`) |
| `src-tauri/src/` | Rust backend: projects (`project.rs`), compiler, SyncTeX, version history (`history/`), collaboration server (`collab/`) |
| `src-tauri/resources/` | LaTeX templates, the sample paper and the bundled TeX cache |
| `docs/` | User docs and design plans (`docs/plans/`) |
| `e2e/` | Browser checks against the real backend |
| `scripts/` | Sidecar download and the browser dev runner |
