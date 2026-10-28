#!/usr/bin/env node
// Drives the real frontend (from the running Vite dev server on :1420) in headless Chrome,
// with Tauri's IPC replaced by a stub that serves a multi-part project folder from memory:
// structure commands (create/delete/reorder/split/merge) work on that copy, and `compile`
// returns the folder's real PDF and the contents LaTeX wrote for it.
//
// Usage: node e2e/make-fixture.mjs /tmp/pf-multipart   (once: splits the sample, typesets it)
//        node e2e/ui-check.mjs /tmp/pf-multipart <out-dir>

import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [projectDir, outDir] = process.argv.slice(2);
if (!projectDir || !outDir) {
  console.error("usage: node e2e/ui-check.mjs <project-dir> <out-dir>");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const meta = JSON.parse(readFileSync(join(projectDir, "paper.json"), "utf8"));
const fixture = {
  dir: projectDir,
  meta,
  parts: meta.parts.map((file) => ({ file, content: readFileSync(join(projectDir, file), "utf8") })),
  bib: readFileSync(join(projectDir, "refs.bib"), "utf8"),
  figures: readdirSync(join(projectDir, "figures")).map((f) => `figures/${f}`),
  toc: JSON.parse(readFileSync(join(projectDir, ".build/toc.json"), "utf8")),
};
// A chapter whose later `#` the report template typesets as one of its sections.
const MARCO = "sections/marco-teorico.md";
fixture.parts.push({ file: MARCO, content: "# Marco Teorico\nAlgun texto\n# Subtema\nTexto 2\n## Detalle\n" });
fixture.meta.parts.push(MARCO);

function stubTauri(fixture) {
  const calls = [];
  window.__pfCalls = calls;
  const state = structuredClone(fixture);
  let id = 0;

  const slug = (text) =>
    text.toLowerCase().replace(/\{[^}]*\}/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "part";
  const uniqueFile = (title) => {
    const taken = new Set(state.parts.map((p) => p.file));
    let file = `sections/${slug(title)}.md`;
    for (let n = 2; taken.has(file); n++) file = `sections/${slug(title)}-${n}.md`;
    return file;
  };
  const snapshot = () => ({
    dir: state.dir,
    meta: { ...state.meta, parts: state.parts.map((p) => p.file) },
    parts: state.parts.map((p) => ({ ...p })),
    bib: state.bib,
    figures: state.figures,
    preamble: state.preamble ?? null,
  });
  const indexOf = (file) => {
    const i = state.parts.findIndex((p) => p.file === file);
    if (i < 0) throw `No part ${file}`;
    return i;
  };
  // Shaped like the backend's flattened view: part lines around each fragment, a `%PF:N` line
  // and a blank line before each block, here with the Markdown standing in for its LaTeX.
  const generatedTex = () => {
    const out = ["\\begin{document}"];
    for (const part of state.parts) {
      out.push(`%PF-PART:${part.file}`);
      const lines = part.content.replace(/\n+$/, "").split("\n");
      lines.forEach((line, i) => {
        if (line.trim() && (i === 0 || !lines[i - 1].trim())) out.push(`%PF:${i + 1}`, "");
        out.push(line);
      });
      out.push("%PF-PART-END");
    }
    out.push("\\end{document}", "");
    return out.join("\n");
  };

  // Version history: snapshots of the last few days, newest first, in memory.
  const history = { enabled: true, versions: [] };
  window.__pfHistory = history;
  let commit = 0;
  const snapshotInfo = (kind, minutesAgo, summary, extra = {}) => {
    const id = ((++commit * 0x9e3779b1) >>> 0).toString(16).padStart(8, "0").repeat(5);
    return {
      id,
      shortId: id.slice(0, 7),
      kind,
      label: null,
      note: null,
      summary,
      time: Math.floor(Date.now() / 1000) - minutesAgo * 60,
      author: "Ada Lovelace",
      changedParts: ["sections/method.md"],
      ...extra,
    };
  };
  history.versions = [
    snapshotInfo("autosave", 4, "Edited: Method"),
    snapshotInfo("autosave", 21, "Edited: Method"),
    snapshotInfo("autosave", 47, "Edited: Introduction, Method"),
    snapshotInfo("version", 70, "Edited: Results · References changed"),
    snapshotInfo("autosave", 95, "Edited: Results"),
    snapshotInfo("version", 26 * 60, "Session 27 Oct 09:12–11:40"),
    snapshotInfo("autosave", 27 * 60, "Edited: Introduction"),
    snapshotInfo("autosave", 28 * 60, "Added: Results"),
    snapshotInfo("version", 3 * 24 * 60, "PDF exported", { label: "First draft", note: "Shared with Prof. Smith" }),
    snapshotInfo("version", 5 * 24 * 60, "Project created"),
  ];
  const historyStatus = () => ({
    enabled: history.enabled,
    mode: history.enabled ? "own" : "none",
    branch: history.enabled ? "main" : null,
    dirty: true,
    lastVersion: history.enabled ? (history.versions.find((v) => v.kind === "version") ?? null) : null,
    remote: null,
  });
  const NOTES = "sections/notes.md";
  // One edited part (a phrase replaced in its middle), one deleted part, and settings,
  // references and a figure in plain language.
  const historyDiff = (from, to) => {
    const part = state.parts.find((p) => p.file === "sections/method.md") ?? state.parts[0];
    const text = part.content;
    const cut = text.indexOf(" ", Math.floor(text.length / 2)) + 1;
    const deleted = state.parts.some((p) => p.file === NOTES) ? [] : [
      {
        file: NOTES,
        oldFile: null,
        title: "Notes",
        status: "deleted",
        segments: [{ kind: "delete", text: "# Notes\n\nThings to check before submitting: the entropy bound and the second experiment.\n" }],
      },
    ];
    return {
      from,
      to,
      parts: [
        {
          file: part.file,
          oldFile: null,
          title: "Method",
          status: "modified",
          segments: [
            { kind: "equal", text: text.slice(0, cut) },
            { kind: "delete", text: "in an earlier wording " },
            { kind: "insert", text: "with clearer wording " },
            { kind: "equal", text: text.slice(cut) },
          ],
        },
        ...deleted,
      ],
      meta: [{ field: "title", description: "Title: “Information” → “Measuring Information”" }],
      bib: [
        { key: "vaswani2017attention", status: "added" },
        { key: "shannon1948", status: "modified" },
      ],
      files: [{ path: "figures/plot.png", oldPath: null, status: "added" }],
    };
  };

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb) {
      const key = ++id;
      window[`_${key}`] = cb;
      return key;
    },
    unregisterCallback() {},
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      calls.push({ cmd, args: cmd === "part_save" ? { file: args.file } : args });
      const file = (p) => fetch(`http://files.local${p}`);
      switch (cmd) {
        case "startup_project":
          return null;
        case "plugin:dialog|open":
          return state.dir;
        case "plugin:dialog|save":
          return `/tmp/${args.options?.defaultPath ?? "export"}`;
        case "project_create":
          state.meta = { ...state.meta, template: args.template, title: args.title || state.meta.title, language: args.language };
          return snapshot();
        case "project_open":
          return snapshot();
        case "project_save":
          if (args.meta) state.meta = { ...args.meta };
          if (args.bib !== undefined) state.bib = args.bib;
          return null;
        case "part_save":
          state.parts[indexOf(args.file)].content = args.content;
          return null;
        case "part_create":
          state.parts.splice(args.index, 0, { file: uniqueFile(args.title), content: `# ${args.title}\n\n` });
          return snapshot();
        case "part_delete":
          if (state.parts.length === 1) throw "A document needs at least one part";
          state.parts.splice(indexOf(args.file), 1);
          return snapshot();
        case "parts_reorder":
          state.parts = args.parts.map((f) => state.parts[indexOf(f)]);
          return snapshot();
        case "part_split": {
          const at = indexOf(args.file);
          const marker = `${"#".repeat(args.level)} `;
          const chunks = [];
          for (const line of state.parts[at].content.split("\n")) {
            if (line.startsWith(marker) || chunks.length === 0) chunks.push([]);
            chunks.at(-1).push(line);
          }
          if (chunks.length < 2) throw "Nothing to split";
          const pieces = chunks.map((lines, i) => ({
            file: i === 0 ? args.file : uniqueFile(lines[0].slice(marker.length)),
            content: `${lines.join("\n").trim()}\n`,
          }));
          state.parts.splice(at, 1, ...pieces);
          return snapshot();
        }
        case "parts_merge": {
          const at = indexOf(args.files[0]);
          const merged = args.files.map((f) => state.parts[indexOf(f)].content.trim()).join("\n\n");
          state.parts = state.parts.filter((p) => !args.files.slice(1).includes(p.file));
          state.parts[at] = { file: args.files[0], content: `${merged}\n` };
          return snapshot();
        }
        case "figure_list":
          return state.figures;
        case "figure_import_bytes": {
          // The bytes are not kept, so the path stays out of `figure_list` (no thumbnail to load).
          const ext = args.name.split(".").pop().toLowerCase();
          const stem = args.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
          return `figures/${stem || "figure"}.${ext}`;
        }
        case "compile":
          await new Promise((r) => setTimeout(r, 300));
          return {
            ok: true,
            cancelled: false,
            pdfPath: `${state.dir}/.build/paper.pdf`,
            pandocMs: 180,
            texMs: 610,
            usedNetwork: false,
            needsRerun: false,
            convertedParts: args.focus ? 1 : state.parts.length,
            toc: state.toc,
            labels: {
              "sec:intro": { number: "1", page: "3" },
              "sec:method": { number: "2", page: "5" },
              "eq:entropy": { number: "2.1", page: "5" },
              "fig:example": { number: "2.1", page: "5" },
              "tbl:results": { number: "2.1", page: "6" },
            },
            diagnostics: [
              {
                severity: "warning",
                stage: "latex",
                message: "Citation `missing2020' on page 5 undefined",
                file: "paper.tex",
                line: 46,
                source: "Cite with \\citep{knuth1984, lamport1994} or in the text: \\citet{shannon1948} showed that",
                part: null,
              },
              {
                severity: "warning",
                stage: "latex",
                message: "Overfull \\hbox (14.2pt too wide) in paragraph",
                file: "part-method.tex",
                line: 3,
                source: "Inline math works as usual, $H(X) \\ge 0$, and labeled display equations are numbered:",
                part: "sections/method.md",
              },
              { severity: "warning", stage: "bibtex", message: "empty journal in shannon1948", file: null, line: null, source: null, part: null },
            ],
          };
        case "read_binary":
          return (await file(args.path)).arrayBuffer();
        case "read_tex":
          if (window.__pfGeneratedTex) return generatedTex();
          return (await file(`${state.dir}/.build/paper.tex`)).text();
        // The blank-line-separated block around the line, with a few Markdown → LaTeX rewrites.
        case "block_latex": {
          const lines = args.content.split("\n");
          if (!lines[args.line - 1]?.trim()) return null;
          let from = args.line;
          let to = args.line;
          while (from > 1 && lines[from - 2].trim()) from--;
          while (to < lines.length && lines[to].trim()) to++;
          const latex = lines
            .slice(from - 1, to)
            .map((l) => l.replace(/\*\*(.+?)\*\*/g, "\\textbf{$1}").replace(/\[@([\w:-]+)\]/g, "\\citep{$1}").replace(/@([\w:-]+)/g, "\\ref{$1}"))
            .join("\n");
          return { fromLine: 40, toLine: 40 + to - from, markdownFrom: from, markdownTo: to, latex, stale: false };
        }
        // No SyncTeX data unless a check sets an answer: the preview falls back to text matching.
        case "synctex_to_source":
          return window.__pfSynctexSource ?? null;
        case "synctex_to_pdf":
          return window.__pfSynctexPdf ?? null;
        case "dictionary_read":
          return state.dictionary ?? [];
        case "dictionary_add":
          state.dictionary = [...new Set([...(state.dictionary ?? []), ...args.words])];
          return state.dictionary;
        case "preamble_save":
          state.preamble = args.content;
          return null;
        case "template_eject":
          state.meta = { ...state.meta, templateFile: `template/${state.meta.template}.tex` };
          return snapshot();
        case "template_restore":
          state.meta = { ...state.meta, templateFile: "" };
          return snapshot();
        case "bib_lookup":
          if (!args.query.includes("10.")) throw `'${args.query}' is not a DOI (10.1234/…) or an arXiv id (2401.01234, hep-th/9901001).`;
          return {
            key: "vaswani2017attention",
            bibtex:
              "@article{vaswani2017attention,\n  title   = {Attention Is All You Need},\n" +
              "  journal = {Advances in Neural Information Processing Systems},\n" +
              "  author  = {Vaswani, Ashish and Shazeer, Noam},\n  year    = {2017}\n}\n",
          };
        case "history_status":
          return historyStatus();
        case "history_enable":
          history.enabled = true;
          return historyStatus();
        case "history_autosave": {
          if (!history.enabled) return null;
          const taken = snapshotInfo("autosave", 0, args.reason ?? "Edited: Method");
          history.versions.unshift(taken);
          return taken;
        }
        case "history_save_version": {
          if (!history.enabled) throw "Version history is off for this project";
          const saved = snapshotInfo("version", 0, args.reason ?? "Edited: Method", { label: args.label, note: args.note });
          history.versions.unshift(saved);
          return saved;
        }
        case "history_list": {
          const shown = history.versions.filter((v) => args.includeAutosaves || v.kind === "version");
          const start = args.before ? shown.findIndex((v) => v.id === args.before) + 1 : 0;
          return shown.slice(start, start + args.limit);
        }
        case "history_label": {
          const version = history.versions.find((v) => v.id === args.id);
          if (version.kind !== "version") throw "Only versions can be named: restore it and save a version";
          version.label = args.label;
          return version;
        }
        case "history_diff":
          return historyDiff(args.from, args.to);
        case "history_read_part":
          return state.parts.find((p) => p.file === args.file)?.content ?? "";
        case "history_restore":
          history.versions.unshift(snapshotInfo("autosave", 0, "Before restoring an earlier version"));
          history.versions.unshift(snapshotInfo("version", 0, "Restored an earlier version"));
          return snapshot();
        case "history_restore_part":
          if (args.file === NOTES && !state.parts.some((p) => p.file === NOTES)) {
            state.parts.push({ file: NOTES, content: "# Notes\n\nThings to check before submitting: the entropy bound and the second experiment.\n" });
          }
          history.versions.unshift(snapshotInfo("version", 0, "Restored “Notes”"));
          return snapshot();
        case "plugin:event|listen":
          (window.__pfListeners ??= {})[args.event] = args.handler;
          return args.handler;
        default:
          return null;
      }
    },
  };
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.route("http://files.local/**", (route) =>
  route.fulfill({ path: decodeURIComponent(new URL(route.request().url()).pathname) }),
);
await page.addInitScript(stubTauri, fixture);

const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`) });
const settle = (ms = 300) => page.waitForTimeout(ms);
// The sidebar's tab bar comes first, the editor's second.
const editorTabs = () => page.getByRole("tablist").nth(1).getByRole("tab");
const editorTab = () => page.getByRole("tablist").nth(1).getByRole("tab", { selected: true }).textContent();
const lastFocus = () =>
  page.evaluate(() => String(window.__pfCalls.filter((c) => c.cmd === "compile").at(-1)?.args.focus));
const lastStructureCall = () =>
  page.evaluate(() => {
    const last = window.__pfCalls.filter((c) => /^part|^parts/.test(c.cmd) && c.cmd !== "part_save").at(-1);
    return last && `${last.cmd} ${JSON.stringify(last.args)}`;
  });

// Welcome, then a new project through the template gallery.
await page.goto(process.env.PF_URL ?? "http://localhost:1420/");
await page.getByRole("button", { name: /New paper/ }).waitFor();
await settle(200);
await shot("01-welcome");

await page.getByRole("button", { name: /New paper/ }).click();
await page.getByRole("dialog", { name: "New paper" }).waitFor();
await page.getByRole("radio", { name: /Thesis \/ Report/ }).click();
await page.getByPlaceholder("Untitled paper").fill("Measuring Information");
await page.getByText("Start from sample").click();
await settle(150);
await shot("02-gallery-create");
await page.getByRole("button", { name: "Continue…" }).click();

await page.waitForSelector(".cm-content", { timeout: 15000 });
await page.waitForSelector(".pf-page canvas", { timeout: 15000 });
await settle(800);
await shot("03-workspace");

// Document menu: the only way, with the status bar, to reach templates once a project is open.
await page.getByRole("button", { name: "Document" }).click();
await settle(150);
await shot("04-document-menu");
await page.getByRole("menuitem", { name: /Contents & lists/ }).click();
await settle(700);
await shot("05-paper-contents");
await page.getByText("List of tables").click();
await settle(400);

// Structure: contents from the last compile, parts as cards.
await page.getByRole("tab", { name: "Structure", exact: true }).click();
await settle(300);
await page.locator("li.group").nth(1).hover();
await settle(200);
await shot("06-structure");

// A later `#` in a chapter part: nested under the chapter in its card, marked in the editor.
const marcoCard = () => page.locator("li.group", { hasText: "Marco Teorico" });
const badges = () => page.locator(".pf-section-of").allTextContents();
async function cardOutline() {
  return marcoCard().evaluate((card) => {
    const title = [...card.querySelectorAll("span")].find((s) => s.textContent === "Marco Teorico");
    const left = (el) => Math.round(el.getBoundingClientRect().left);
    const textLeft = (b) => {
      const range = document.createRange();
      range.selectNodeContents(b);
      return Math.round(range.getBoundingClientRect().left);
    };
    const items = [...card.querySelectorAll("ul button")].map((b) => `${b.textContent}@+${textLeft(b) - left(title)}px`);
    return `${title.textContent}@0 > ${items.join(", ")}`;
  });
}
await marcoCard().getByTitle(`Open ${MARCO}`).click({ position: { x: 16, y: 12 } });
await page.locator(".pf-section-of").first().waitFor({ timeout: 5000 });
await page.mouse.move(5, 890);
await settle(300);
await marcoCard().screenshot({ path: join(outDir, "06b-chapter-card.png") });
const editorBox = await page.locator(".cm-editor").boundingBox();
await page.screenshot({ path: join(outDir, "06c-chapter-badge.png"), clip: { ...editorBox, height: 200 } });
await shot("06d-chapter-workspace");
console.log("chapter card (text x relative to the title):", await cardOutline());
console.log("chapter badges:", JSON.stringify(await badges()));

// Outline folding: a gutter click folds one heading's section and keeps its chapter badge;
// Mod-Alt-[ folds every top-level section, Mod-Alt-] unfolds them all.
const foldedCount = () => page.locator(".cm-foldPlaceholder").count();
const foldGutter = await page.locator(".pf-fold-gutter").boundingBox();
const subtemaLine = await page.locator(".cm-line", { hasText: "Subtema" }).boundingBox();
await page.mouse.click(foldGutter.x + foldGutter.width / 2, subtemaLine.y + 8);
await settle(200);
await page.screenshot({ path: join(outDir, "06e-folded-heading.png"), clip: { ...editorBox, height: 200 } });
console.log("folded ranges after a gutter click:", await foldedCount(), "· badges", JSON.stringify(await badges()));
await page.click(".cm-content");
await page.keyboard.press("ControlOrMeta+Alt+BracketLeft");
await settle(200);
const foldedAll = await foldedCount();
await page.keyboard.press("ControlOrMeta+Alt+BracketRight");
await settle(200);
console.log("fold all:", foldedAll, "ranges · after unfold all:", await foldedCount());

// A contents entry opens the PDF at its page and the Markdown at its heading.
await page.getByRole("list", { name: "Table of contents" }).getByRole("button", { name: /Results/ }).click();
await settle(900);
await shot("07-toc-entry-click");
console.log("contents click opened:", await page.locator(".cm-activeLine").first().textContent());

// Merge everything into one part: three top-level headings in one file get the split hint.
for (let i = 0; i < 2; i++) {
  await page.locator("li.group").first().hover();
  await page.locator("li.group").first().getByRole("button", { name: "Merge with next" }).click();
  await settle(400);
}
await page.mouse.move(5, 890);
await settle(300);
await shot("08-split-hint");
console.log("after merging, cards:", await page.locator("li.group").count(), "·", await lastStructureCall());
await page.locator("li.group").first().getByRole("button", { name: "Split", exact: true }).click();
await settle(600);
console.log("after split, cards:", await page.locator("li.group").count(), "·", await lastStructureCall());

// Add a chapter after the second one, with its title asked inline.
await page.locator("li.group").nth(1).hover();
await page.locator("li.group").nth(1).getByRole("button", { name: "Add chapter after" }).click();
await page.getByPlaceholder("New chapter title").fill("Discussion");
await settle(150);
await shot("09-add-chapter");
await page.keyboard.press("Enter");
await settle(600);
console.log("after add, cards:", await page.locator("li.group").count(), "active tab:", await editorTab());

// Part switcher in the editor tab bar.
await page.getByRole("button", { name: /^All chapters/ }).click();
await settle(150);
await shot("10-part-switcher");
await page.getByRole("menuitem", { name: /Introduction/ }).click();
await settle(300);

// Problems panel: a diagnostic from part-method.tex jumps into sections/method.md.
await page.keyboard.press("ControlOrMeta+j");
await settle(200);
await page.getByText("Overfull").click();
await settle(500);
await shot("11-problems-jump");
console.log("problem jumped to:", await editorTab(), "/", await page.locator(".cm-activeLine").first().textContent());
await page.getByText("Citation `missing2020'").click();
await settle(400);
console.log("citation problem jumped to:", await editorTab());

// Typing: citation autocomplete (labels from every part) and slash commands.
await page.click(".cm-content");
await page.keyboard.press("ControlOrMeta+End");
await page.keyboard.type("\n\nAs shown in @tbl");
await page.waitForSelector(".cm-tooltip-autocomplete", { timeout: 5000 });
await shot("12-cite-autocomplete-other-part");
const completionRows = () =>
  page
    .locator(".cm-tooltip-autocomplete li")
    .evaluateAll((rows) =>
      rows.map((r) => `${r.querySelector(".cm-completionLabel")?.textContent} (${r.querySelector(".cm-completionDetail")?.textContent ?? ""})`),
    );
console.log("label completion:", JSON.stringify(await completionRows()));
await page.keyboard.press("Escape");

// Reference picker: `/ref` lists labels with their names and inserts the name with the reference.
await page.keyboard.type(" and /refres");
await page.locator(".cm-tooltip-autocomplete li", { hasText: "@tbl:results" }).waitFor({ timeout: 5000 });
await shot("12b-reference-picker");
console.log("reference picker:", JSON.stringify(await completionRows()));
await page.keyboard.press("Enter");
await settle(150);
console.log("after picking a reference:", await page.locator(".cm-activeLine").first().textContent());
await page.keyboard.type("\n\n/re");
await page.locator(".cm-tooltip-autocomplete li", { hasText: "Cross reference" }).click();
await page.locator(".cm-tooltip-autocomplete li", { hasText: "@fig:example" }).waitFor({ timeout: 5000 });
console.log("/ref slash command opens the picker:", (await completionRows()).length, "labels");
await page.keyboard.press("Escape");
await page.keyboard.press("Backspace");
await page.keyboard.press("Backspace");
await page.keyboard.press("Backspace");
await page.keyboard.press("Backspace");
await page.keyboard.type("\n\n/to");
await page.waitForSelector(".cm-tooltip-autocomplete", { timeout: 5000 });
await shot("13-slash-toc");
await page.keyboard.press("Escape");
await page.keyboard.type("\n\nA claim");
await page.getByRole("button", { name: "Footnote" }).click();
await settle(150);
console.log("footnote button:", await page.locator(".cm-activeLine").first().textContent());

// KaTeX hover, in the method chapter.
await page.locator("li.group").nth(1).click();
await settle(300);
await page.locator(".pf-math").first().hover();
await page.waitForSelector(".pf-math-tooltip .katex", { timeout: 5000 });
await shot("14-math-hover");

// Figure inspector on the sample figure: width slider and the .wide toggle edit only its attributes.
const figureLine = () => page.locator(".cm-line", { hasText: "figures/example.png" });
await figureLine().click({ position: { x: 40, y: 8 } });
await page.getByRole("button", { name: "Edit figure" }).click();
const inspector = page.getByRole("dialog", { name: "Figure" });
await inspector.getByRole("slider", { name: "Width" }).fill("50");
await inspector.getByRole("checkbox", { name: /Span both columns/ }).check();
await settle(200);
await shot("14b-figure-inspector");
console.log("figure after inspector:", await figureLine().textContent());
await page.keyboard.press("Escape");

// Pasting an image saves it into figures/ and inserts a labelled figure after the cursor's line.
await page.locator(".cm-content").evaluate((el) => {
  const data = new DataTransfer();
  data.items.add(new File([new Uint8Array([137, 80, 78, 71])], "Screen Shot.png", { type: "image/png" }));
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
});
await page.locator(".cm-line", { hasText: "figures/screen-shot.png" }).waitFor({ timeout: 5000 });
console.log("pasted figure:", await page.locator(".cm-line", { hasText: "figures/screen-shot.png" }).textContent());
await page.keyboard.press("Escape");

await page.getByRole("tab", { name: "Refs", exact: true }).click();
await settle(200);
await shot("15-references");

// Add by DOI: a bad query explains itself, a good one is previewed, then appended to refs.bib.
const doiInput = page.getByLabel("DOI or arXiv id");
await doiInput.fill("not an id");
await page.getByRole("button", { name: "Look up" }).click();
console.log("bad DOI lookup:", await page.getByRole("alert").textContent({ timeout: 5000 }));
await doiInput.fill("https://doi.org/10.5555/3295222.3295349");
await page.getByRole("button", { name: "Look up" }).click();
await page.getByRole("group", { name: "Reference preview" }).waitFor({ timeout: 5000 });
await shot("15b-reference-preview");
await page.getByRole("button", { name: "Add to refs.bib" }).click();
await page.getByText("@vaswani2017attention", { exact: true }).waitFor({ timeout: 5000 });
await settle(1500);
const savedBib = await page.evaluate(() => window.__pfCalls.filter((c) => c.cmd === "project_save" && c.args.bib).at(-1)?.args.bib);
console.log(
  "add by DOI: entry listed,",
  savedBib?.startsWith(fixture.bib) && savedBib.endsWith("year    = {2017}\n}\n") ? "refs.bib appended ok" : "refs.bib NOT appended",
);
await page.getByRole("tab", { name: "Figures", exact: true }).click();
await settle(500);

// Double-click a word in the PDF: with SyncTeX data the editor opens the line it names, and the
// cursor reveal flashes the box it names.
await page.getByRole("tab", { name: "Structure", exact: true }).click();
await page.locator(".pf-page").first().scrollIntoViewIfNeeded();
const span = page.locator(".textLayer span", { hasText: "measured" }).first();
await span.scrollIntoViewIfNeeded();
await page.evaluate(() => (window.__pfSynctexSource = { part: "sections/method.md", line: 3 }));
await span.dblclick();
await settle(500);
console.log("SyncTeX double-click opened:", await editorTab(), "/", await page.locator(".cm-activeLine").first().textContent());
await page.evaluate(() => (window.__pfSynctexPdf = { page: 2, x: 72, y: 300, width: 400, height: 12 }));
await page.getByRole("button", { name: "Show cursor position in PDF" }).click();
await settle(700);
const revealedPage = await page.evaluate(() =>
  [...document.querySelectorAll(".pf-page")].findIndex((p) => p.parentElement.querySelector(".pf-reveal")),
);
console.log("SyncTeX cursor reveal on page:", revealedPage + 1);
await page.evaluate(() => (window.__pfSynctexSource = window.__pfSynctexPdf = null));

// Without SyncTeX data: the editor opens the part with the clicked sentence.
await span.scrollIntoViewIfNeeded();
await span.dblclick();
await settle(500);
console.log("PDF double-click opened:", await editorTab(), "/", await page.locator(".cm-activeLine").first().textContent());

// "Current chapter only": preview compiles get the active part as `focus` and follow it.
await page.getByRole("button", { name: "Current chapter only" }).click();
await settle(700);
const focusBefore = await lastFocus();
await page.locator("li.group").nth(1).click();
await settle(700);
console.log("chapter-only focus:", focusBefore, "→ after opening chapter 2:", await lastFocus());
await page.getByRole("button", { name: "Current chapter only" }).click();
await settle(700);
console.log("chapter-only off, focus:", await lastFocus());

// Template change from the status bar: the gallery in change mode.
await page.locator("footer").getByRole("button", { name: "Thesis / Report" }).click();
await page.getByRole("dialog", { name: "Change template" }).waitFor();
await settle(150);
await shot("16-gallery-change");
await page.keyboard.press("Escape");
await settle(150);

// Dark theme, and the generated LaTeX.
await page.getByRole("button", { name: "Dark theme" }).click();
await settle(400);
await shot("17-dark-structure");
await page.getByRole("button", { name: "Document" }).click();
await settle(150);
await shot("18-dark-document-menu");
await page.keyboard.press("Escape");
await page.getByRole("tab", { name: "LaTeX (generated)" }).click();
await settle(400);
await shot("19-generated-tex");

// Narrow window: the toolbar must not clip.
await page.setViewportSize({ width: 1100, height: 760 });
await editorTabs().first().click();
await settle(500);
await shot("20-narrow-1100-dark");
await page.getByRole("button", { name: "Light theme" }).click();
await page.getByRole("tab", { name: "Paper", exact: true }).click();
await settle(400);
await shot("21-narrow-1100-light-paper");
const overflow = await page.evaluate(() => {
  const header = document.querySelector("header");
  return [...header.querySelectorAll("button")]
    .filter((b) => b.getBoundingClientRect().right > header.getBoundingClientRect().right + 0.5)
    .map((b) => b.getAttribute("aria-label") ?? b.textContent);
});
console.log("toolbar buttons clipped at 1100px:", overflow.length ? overflow : "none");
await page.setViewportSize({ width: 1440, height: 900 });

// The chapter rule follows the template: none in an article, back in the report.
async function pickTemplate(current, next) {
  await page.locator("footer").getByRole("button", { name: current }).click();
  await page.getByRole("dialog", { name: "Change template" }).getByRole("radio", { name: new RegExp(next) }).click();
  await settle(400);
}
await page.getByRole("tab", { name: "Structure", exact: true }).click();
await marcoCard().getByTitle(`Open ${MARCO}`).click({ position: { x: 16, y: 12 } });
await settle(300);
await pickTemplate("Thesis / Report", "^Article");
console.log("article: badges", JSON.stringify(await badges()), "· card", await cardOutline());
await shot("21b-article-chapter-card");
await pickTemplate("Article", "Thesis \\/ Report");
console.log("report again: badges", JSON.stringify(await badges()), "· card", await cardOutline());

// Find/replace across parts: replace all, then Mod-Z undoes it in one part only, both in a part
// that was in the view and in one that was not open during the replace.
const findGroups = () =>
  page.getByLabel("Find results").locator("section").evaluateAll((sections) =>
    Object.fromEntries(sections.map((s) => [s.getAttribute("aria-label"), Number(s.querySelector("span + span").textContent)])),
  );
async function undoIn(title) {
  await page.getByRole("button", { name: /^All chapters/ }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^\\d+\\. ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).click();
  await settle(300);
  await page.click(".cm-content");
  await page.keyboard.press("ControlOrMeta+z");
  await settle(500);
  return findGroups();
}
await page.click(".cm-content");
await page.keyboard.press("ControlOrMeta+Shift+f");
await page.getByLabel("Find in all parts").fill("the");
await page.getByRole("button", { name: "Match case" }).click();
await page.getByRole("button", { name: "Whole word" }).click();
await page.getByText("Skip math, code and citations").click();
await page.getByLabel("Replace with").fill("THE");
await settle(400);
await shot("21c-find-results");
const findBefore = await findGroups();
const [inView, notOpen] = Object.keys(findBefore);
await page.getByRole("region", { name: inView, exact: true }).locator("button").nth(1).click();
await settle(300);
await page.getByRole("button", { name: "Replace all" }).click();
await settle(500);
const findAfter = await findGroups();
const afterUndoNotOpen = await undoIn(notOpen);
const afterUndoInView = await undoIn(inView);
const findOk =
  Object.keys(findAfter).length === 0 &&
  JSON.stringify(afterUndoNotOpen) === JSON.stringify({ [notOpen]: findBefore[notOpen] }) &&
  afterUndoInView[inView] === findBefore[inView] &&
  afterUndoInView[notOpen] === findBefore[notOpen];
console.log(
  `find/replace: ${findOk ? "ok" : "FAILED"} · before ${JSON.stringify(findBefore)} · after replace all ${JSON.stringify(findAfter)}`,
  `· undo in ${notOpen} ${JSON.stringify(afterUndoNotOpen)} · undo in ${inView} ${JSON.stringify(afterUndoInView)}`,
);
await page.getByRole("tab", { name: "Structure", exact: true }).click();
// Spell check: a misspelled word gets suggestions, and adding it to the project dictionary clears it.
const typo = () => page.locator(".pf-spell", { hasText: "sentense" }).first();
await page.click(".cm-content");
await page.keyboard.press("ControlOrMeta+End");
await page.keyboard.type("\n\nThis sentense has a typo. ");
await typo().waitFor({ timeout: 10000 });
await typo().hover();
await page.locator(".pf-spell-suggestions button").first().waitFor({ timeout: 10000 });
await shot("22-spell-suggestions");
console.log("spell suggestions:", JSON.stringify(await page.locator(".pf-spell-suggestions button").allTextContents()));
await page.getByRole("button", { name: "Add to project dictionary" }).click();
await typo().waitFor({ state: "detached", timeout: 5000 });
console.log(
  "after adding to the project dictionary:",
  JSON.stringify(await page.evaluate(() => window.__pfCalls.filter((c) => c.cmd === "dictionary_add").map((c) => c.args.words))),
);

// Grammar check (English, Harper in a worker): a grammar mark offers suggestions and one fixes the
// line; a misspelled word keeps only its spelling mark.
const grammarMark = () => page.locator(".pf-grammar").filter({ hasText: /^an$/ }).first();
const lintMarks = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".cm-lintRange")].map((el) => `${el.classList.contains("pf-grammar") ? "grammar" : el.classList.contains("pf-spell") ? "spell" : "other"}:${el.textContent}`),
  );
await page.click(".cm-content");
await page.keyboard.press("ControlOrMeta+End");
await page.keyboard.type("\n\nThis is an test of teh grammar checker. ");
const grammarStart = Date.now();
await grammarMark().waitFor({ timeout: 30000 });
await page.locator(".pf-spell").filter({ hasText: /^teh$/ }).first().waitFor({ timeout: 10000 });
await settle(1500);
const marks = await lintMarks();
const tehMarks = marks.filter((m) => m.endsWith(":teh"));
console.log(
  `grammar: first mark after ${Date.now() - grammarStart} ms · marks ${JSON.stringify(marks)} · "teh" ${
    JSON.stringify(tehMarks) === JSON.stringify(["spell:teh"]) ? "spelling only, no duplicate" : `DUPLICATED ${JSON.stringify(tehMarks)}`
  }`,
);
await grammarMark().hover();
const grammarTip = page.locator(".cm-tooltip-lint .cm-diagnostic").filter({ has: page.locator(".cm-diagnosticAction", { hasText: "Ignore" }) }).first();
await grammarTip.waitFor({ timeout: 5000 });
await shot("22a-grammar-suggestions");
const grammarActions = await grammarTip.locator(".cm-diagnosticAction").allTextContents();
console.log("grammar message:", JSON.stringify(await grammarTip.locator(".cm-diagnosticText").textContent()), "· actions:", JSON.stringify(grammarActions));
await grammarTip.locator(".cm-diagnosticAction").first().click();
await settle(300);
console.log(
  "after the grammar suggestion:",
  JSON.stringify(await page.locator(".cm-line").filter({ hasText: "grammar checker" }).first().textContent()),
);
await page.locator(".pf-grammar").filter({ hasText: /^an$/ }).waitFor({ state: "detached", timeout: 5000 });
const grammarToggle = page.locator("footer").getByRole("button", { name: "Grammar check" });
console.log("grammar toggle pressed:", await grammarToggle.getAttribute("aria-pressed"), "·", await grammarToggle.getAttribute("title"));

// Word goals, set from the status bar counter.
const wordCounter = page.locator("footer").getByRole("button", { name: "Word count" });
await wordCounter.click();
const goalDialog = page.getByRole("dialog", { name: "Word goals" });
await goalDialog.getByRole("spinbutton", { name: /Document goal/ }).fill("5000");
await goalDialog.getByRole("spinbutton", { name: /Session goal/ }).fill("200");
await shot("22b-word-goal-popover");
await goalDialog.getByRole("button", { name: "Set goal" }).click();
await settle(200);
await page.locator("footer").screenshot({ path: join(outDir, "22c-word-goal-status.png") });
console.log("status bar with word goals:", await wordCounter.textContent());

// LaTeX settings: preamble.tex opens as an editor tab and saves; the template ejects and restores.
await page.getByRole("tab", { name: "Paper", exact: true }).click();
await page.getByRole("button", { name: "Create preamble.tex" }).click();
await settle(200);
await page.click(".cm-content");
await page.keyboard.press("ControlOrMeta+End");
await page.keyboard.type("\\newcommand\\pf{PaperForge}\n");
await settle(700);
const preambleSaves = await page.evaluate(() => window.__pfCalls.filter((c) => c.cmd === "preamble_save").map((c) => c.args.content));
console.log("preamble tab:", await editorTab(), "· last save:", JSON.stringify(preambleSaves.at(-1)));
await page.getByRole("button", { name: "Eject template…" }).click();
await settle(500);
await shot("22d-eject-confirm");
await page.getByRole("alertdialog", { name: "Eject template" }).getByRole("button", { name: "Eject" }).click();
await page.getByRole("button", { name: "Restore built-in template" }).waitFor({ timeout: 5000 });
await shot("22e-ejected");
await page.getByRole("button", { name: "Restore built-in template" }).click();
await page.getByRole("button", { name: "Eject template…" }).waitFor({ timeout: 5000 });
console.log(
  "template commands:",
  (await page.evaluate(() => window.__pfCalls.filter((c) => c.cmd.startsWith("template_")).map((c) => c.cmd))).join(", "),
);

// Page setup: margins, paper and header from the Paper tab end up in the saved paper.json; a
// journal template says the journal sets the page.
const pageSetup = page.getByRole("region", { name: "Page setup" });
await pageSetup.scrollIntoViewIfNeeded();
await pageSetup.getByRole("checkbox", { name: "Same on all sides" }).uncheck();
await pageSetup.getByRole("spinbutton", { name: "Top margin" }).fill("3");
await pageSetup.getByRole("spinbutton", { name: "Left margin" }).fill("2.2");
await pageSetup.getByRole("combobox", { name: "Margin unit" }).selectOption("mm");
await pageSetup.getByRole("combobox", { name: "Paper" }).selectOption("letterpaper");
await pageSetup.getByRole("combobox", { name: "Line spacing" }).selectOption("onehalf");
await pageSetup.getByRole("textbox", { name: "Header right" }).fill("Draft {page}");
await settle(1200);
await pageSetup.screenshot({ path: join(outDir, "22f-page-setup.png") });
const savedMeta = await page.evaluate(() => window.__pfCalls.filter((c) => c.cmd === "project_save" && c.args.meta).at(-1)?.args.meta);
console.log("page setup saved layout:", JSON.stringify(savedMeta?.layout), "· class options:", JSON.stringify(savedMeta?.classOptions));
console.log("class options field:", await page.getByPlaceholder("twocolumn, 10pt").inputValue());
await pickTemplate("Thesis / Report", "IEEE");
await page.getByRole("tab", { name: "Paper", exact: true }).click();
console.log("IEEE page setup:", await page.getByRole("region", { name: "Page setup" }).locator("p").textContent());
await pickTemplate("IEEE Conference", "Thesis \\/ Report");

// Styles: a character style applied to the editor's selection from the Paper panel adds the
// built-in to the project; applying it again removes it.
await editorTabs().first().click();
await settle(300);
await page.click(".cm-content");
await page.keyboard.press("ControlOrMeta+End");
await page.keyboard.type("\n\nSmall caps here");
await page.keyboard.press("Shift+Home");
const applySmallcaps = () => page.getByRole("button", { name: "Apply smallcaps" });
await applySmallcaps().scrollIntoViewIfNeeded();
await applySmallcaps().click();
await settle(700);
await page.getByRole("list", { name: "Project styles" }).scrollIntoViewIfNeeded();
await shot("22g-style-applied");
const savedStyles = await page.evaluate(() =>
  (window.__pfCalls.filter((c) => c.cmd === "project_save" && c.args.meta).at(-1)?.args.meta.styles ?? []).map((s) => s.name),
);
console.log("character style applied:", await page.locator(".cm-activeLine").first().textContent(), "· saved styles:", JSON.stringify(savedStyles));
await applySmallcaps().click();
await settle(200);
console.log("character style applied again:", await page.locator(".cm-activeLine").first().textContent());

// Writing mode: math, chips and figures render in place, the cursor's line shows its source,
// and a click on a widget puts the cursor into its source.
const modeButton = (name) => page.getByRole("group", { name: "Editor mode" }).getByRole("button", { name, exact: true });
const activeLineText = () => page.locator(".cm-activeLine").first().textContent();
async function openChapter(title) {
  await page.getByRole("button", { name: /^All chapters/ }).click();
  await page.getByRole("menuitem", { name: new RegExp(title) }).click();
  await settle(300);
}
await editorTabs().first().click();
await openChapter("Introduction");
await modeButton("Writing").click();
await page.locator(".pf-lp-chip").first().waitFor({ timeout: 5000 });
await page.locator(".cm-line", { hasText: "Write your paper" }).click({ position: { x: 60, y: 8 } });
await settle(200);
const heading = () => page.locator(".cm-line.pf-lp-h1").first().textContent();
const chips = (kind) => page.locator(`.pf-lp-${kind}`).allTextContents();
console.log("writing mode: citation chips", JSON.stringify(await chips("cite")), "· reference chips", JSON.stringify(await chips("ref")));
console.log("writing mode: heading away from the cursor:", JSON.stringify(await heading()));
await shot("23-writing-mode");
await page.keyboard.press("ControlOrMeta+Home");
await settle(200);
console.log("writing mode: heading with the cursor on it:", JSON.stringify(await heading()));
await shot("23b-writing-heading-source");
await page.locator(".pf-lp-cite").first().click();
await settle(200);
console.log("writing mode: clicked citation chip, cursor line:", JSON.stringify(await activeLineText()));
await openChapter("Method");
await page.locator(".pf-lp-math .katex").first().waitFor({ timeout: 5000 });
await page.locator(".pf-lp-figure img").first().waitFor({ timeout: 5000 });
await page.mouse.move(5, 890);
await settle(300);
console.log(
  "writing mode: rendered math",
  await page.locator(".pf-lp-math .katex").count(),
  "· equation numbers",
  JSON.stringify(await page.locator(".pf-lp-eqno").allTextContents()),
  "· figures",
  JSON.stringify(await page.locator(".pf-lp-caption").allTextContents()),
);
await shot("23c-writing-math-figure");

// Writing mode tables: the sample's pipe table is a grid; each committed edit rewrites only its
// lines as an aligned pipe table, and one Mod-Z undoes one edit.
const docText = () =>
  page.evaluate(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("@codemirror_view"));
    const { EditorView } = await import(url);
    return EditorView.findFromDOM(document.querySelector(".cm-editor")).state.doc.toString();
  });
const TABLE = /\n(\|[^\n]*Model[\s\S]*?)\n\n/;
const tableSource = async () => TABLE.exec(await docText())?.[1];
const grid = page.locator(".pf-table").first();
await grid.scrollIntoViewIfNeeded();
const outsideTable = (await docText()).replace(TABLE, "");
console.log("table grid: cells", await grid.locator("th, td").count(), "· caption", JSON.stringify(await page.locator(".pf-table-caption").first().textContent()));
await grid.locator("td", { hasText: "0.812" }).click();
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("0.900");
await page.keyboard.press("Tab");
console.log("table after a cell edit:\n" + (await tableSource()));
await grid.hover();
await grid.getByRole("button", { name: "Add row below" }).click();
await page.keyboard.type("Small");
await page.keyboard.press("Enter");
await grid.locator("td").first().click();
await grid.getByRole("button", { name: "Align center" }).click();
await settle(200);
await shot("23d-writing-table-grid");
console.log("table after adding a row and centering column 1:\n" + (await tableSource()));
await page.keyboard.press("ControlOrMeta+z");
await settle(200);
console.log("table after one undo:\n" + (await tableSource()));
console.log("text outside the table unchanged:", (await docText()).replace(TABLE, "") === outsideTable);
await page.getByRole("textbox", { name: "Table caption" }).click();
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("Results on the held-out set.");
await page.keyboard.press("Enter");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("held out");
await page.keyboard.press("Enter");
await settle(200);
console.log("caption after editing its text and label:", JSON.stringify((await docText()).match(/\n(: [^\n]*)/)?.[1]));
await grid.getByRole("button", { name: "Edit as text" }).click();
await settle(200);
console.log("edit as text: grids", await page.locator(".pf-table").count(), "· cursor line", JSON.stringify(await activeLineText()));

// `/table` asks for the size with a small grid, then inserts an aligned table with caption and label.
await page.keyboard.press("ControlOrMeta+End");
await page.mouse.move(5, 890);
await page.keyboard.type("\n\n/table");
await page.locator(".cm-tooltip-autocomplete li[aria-selected]", { hasText: "/table" }).waitFor({ timeout: 5000 });
await page.keyboard.press("Enter");
await page.getByRole("dialog", { name: "Insert table" }).waitFor({ timeout: 5000 });
await page.keyboard.press("ArrowRight");
await shot("23e-table-picker");
console.log("table picker:", await page.locator(".pf-table-picker-size").textContent());
await page.keyboard.press("Enter");
await settle(200);
const inserted = await docText();
console.log("inserted table:\n" + inserted.slice(inserted.lastIndexOf("| Column 1")));
await page.keyboard.press("Escape");
await page.keyboard.press("ControlOrMeta+z");
await settle(200);
await page.locator(".pf-lp-math").first().hover();
await settle(600);
console.log("writing mode: KaTeX hover tooltips on rendered math:", await page.locator(".pf-math-tooltip").count());

// Equation editor: a click on the display equation opens MathLive; Cancel and Escape leave the
// text alone, and an edit of the raw LaTeX writes back only the formula between the `$$`.
const editorDoc = () =>
  page.evaluate(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("@codemirror_view"));
    const { EditorView } = await import(url);
    return EditorView.findFromDOM(document.querySelector(".cm-editor")).state.doc.toString();
  });
const mathDialog = page.getByRole("dialog", { name: "Edit equation" });
const openEquation = async () => {
  await page.locator(".pf-lp-math-display").first().click();
  await mathDialog.locator("math-field").waitFor({ timeout: 10000 });
};
const docBefore = await editorDoc();
await openEquation();
await settle(300);
await shot("23d-equation-editor");
console.log(
  "equation editor: math-field",
  JSON.stringify(await mathDialog.locator("math-field").evaluate((mf) => mf.value)),
  "· raw",
  JSON.stringify(await mathDialog.getByRole("textbox", { name: "LaTeX", exact: true }).inputValue()),
);
await mathDialog.getByRole("button", { name: "Cancel" }).click();
console.log("equation editor: cancel leaves the document unchanged:", (await editorDoc()) === docBefore);
await openEquation();
await page.keyboard.press("Escape");
console.log("equation editor: escape leaves the document unchanged:", (await editorDoc()) === docBefore, "· open:", await mathDialog.count());
await openEquation();
await mathDialog.getByRole("textbox", { name: "LaTeX", exact: true }).fill("H(X) = -\\sum_{x} p(x) \\log_2 p(x)");
await settle(300);
await shot("23e-equation-edited");
await mathDialog.getByRole("button", { name: "Apply" }).click();
await settle(200);
const docAfter = await editorDoc();
const changedLines = docAfter.split("\n").filter((line, i) => line !== docBefore.split("\n")[i]);
console.log("equation editor: after apply, changed lines:", JSON.stringify(changedLines));
await modeButton("Source").click();
await settle(200);
console.log(
  "source mode again: widgets",
  await page.locator(".pf-lp-math, .pf-lp-chip, .pf-lp-figure").count(),
  "· math source shown:",
  (await page.locator(".cm-content").textContent()).includes("$$H(X)"),
);
await page.locator(".cm-line", { hasText: "Inline math works" }).getByText("ge 0").click();
await page.keyboard.press("ControlOrMeta+Alt+m");
await mathDialog.locator("math-field").waitFor({ timeout: 5000 });
console.log("source mode: Mod-Alt-m opens the equation editor on", JSON.stringify(await mathDialog.getByRole("textbox", { name: "LaTeX", exact: true }).inputValue()));
await shot("23f-equation-editor-source-mode");
await page.keyboard.press("Escape");
console.log("source mode: escape leaves the document unchanged:", (await editorDoc()) === docAfter);

// Show LaTeX: Mod-Alt-L opens the cursor block's generated LaTeX; converting it to a raw LaTeX
// block is one edit that Mod-Z undoes. In Writing mode the "TeX" handle opens the same popover.
const editorText = () =>
  page.evaluate(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("@codemirror_view"));
    const { EditorView } = await import(url);
    return EditorView.findFromDOM(document.querySelector(".cm-editor")).state.doc.toString();
  });
const latexPopover = page.getByRole("dialog", { name: "Generated LaTeX" });
await page.locator(".cm-line", { hasText: "Inline math works" }).click({ position: { x: 60, y: 8 } });
await page.keyboard.press("ControlOrMeta+Alt+l");
await latexPopover.locator(".cm-line").first().waitFor({ timeout: 5000 });
await settle(200);
await shot("24-show-latex");
console.log("show LaTeX, first line:", JSON.stringify(await latexPopover.locator(".cm-line").first().textContent()));
const beforeConvert = await editorText();
await latexPopover.getByRole("button", { name: "Convert to raw LaTeX…" }).click();
await shot("24b-convert-confirm");
console.log("convert warning:", JSON.stringify(await latexPopover.getByRole("alert").textContent()));
await latexPopover.getByRole("button", { name: "Convert", exact: true }).click();
await settle(200);
const converted = (await editorText()).split("\n");
const fenceAt = converted.indexOf("```{=latex}");
console.log("converted Markdown:", JSON.stringify(converted.slice(Math.max(0, fenceAt - 1), converted.indexOf("```", fenceAt) + 2)));
await page.keyboard.press("ControlOrMeta+z");
await settle(200);
console.log("undo restores the Markdown:", (await editorText()) === beforeConvert, "· popover open:", await latexPopover.count());
await modeButton("Writing").click();
await page.locator(".cm-line", { hasText: "Inline math works" }).click({ position: { x: 60, y: 8 } });
await settle(200);
await page.locator(".pf-showlatex-handle").click();
await latexPopover.locator(".cm-line").first().waitFor({ timeout: 5000 });
await shot("24c-show-latex-writing");
console.log("writing mode TeX handle, first line:", JSON.stringify(await latexPopover.locator(".cm-line").first().textContent()));
await page.keyboard.press("Escape");
await settle(150);
console.log("after Escape, popover open:", await latexPopover.count());
await modeButton("Source").click();
await settle(200);

// The generated tab follows the Markdown cursor, and a double-click goes back to the Markdown.
await page.evaluate(() => (window.__pfGeneratedTex = true));
await page.locator(".cm-line", { hasText: "Raw LaTeX passes" }).click({ position: { x: 60, y: 8 } });
await page.getByRole("tab", { name: "LaTeX (generated)" }).click();
await settle(800);
await shot("25-generated-follows");
console.log("generated tab followed the cursor to:", JSON.stringify(await activeLineText()));
await page.locator(".cm-line", { hasText: "Lists, *emphasis*" }).first().dblclick({ position: { x: 60, y: 8 } });
await settle(500);
console.log("generated double-click jumped to:", await editorTab(), "/", JSON.stringify(await activeLineText()));
await page.evaluate(() => (window.__pfGeneratedTex = false));
await openChapter("Method");

// Comments: Mod-Alt-C on a selection asks for the commenter's name once, then the text, and wraps
// only the selection; the panel lists, resolves and deletes; Review compiles with `review`.
const selectText = (text) =>
  page.evaluate(async (text) => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("@codemirror_view"));
    const { EditorView } = await import(url);
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    const from = view.state.doc.toString().indexOf(text);
    view.dispatch({ selection: { anchor: from, head: from + text.length } });
    view.focus();
  }, text);
const methodBefore = await editorText();
await selectText("works as usual");
await page.keyboard.press("ControlOrMeta+Alt+c");
const addBox = page.getByRole("dialog", { name: "Add comment" });
await addBox.getByLabel("Your name").fill("Ada Lovelace");
await addBox.getByLabel("Comment").fill('Is "usual" the right word?');
await shot("26-add-comment");
await addBox.getByRole("button", { name: "Comment", exact: true }).click();
await settle(200);
const commented = (await editorText()).split("\n");
const changedComment = commented.filter((line, i) => line !== methodBefore.split("\n")[i]);
console.log("comment Markdown:", JSON.stringify(changedComment));
console.log(
  "comment wraps only the selection:",
  commented.join("\n").replace(/\[(works as usual)\]\{\.comment author="Ada Lovelace" date="[\d-]+T[\d:]+" text="Is \\"usual\\" the right word\?"\}/, "$1") ===
    methodBefore,
);
await selectText("labeled display equations");
await page.keyboard.press("ControlOrMeta+Alt+c");
console.log("second comment asks for the name again:", await addBox.getByLabel("Your name").count());
await addBox.getByLabel("Comment").fill("Say numbered?");
await addBox.getByLabel("Comment").press("ControlOrMeta+Enter");
await settle(200);
await page.getByRole("tab", { name: "Review", exact: true }).click();
const commentCards = () => page.getByRole("list", { name: "Comments" }).getByRole("listitem");
await commentCards().first().waitFor({ timeout: 5000 });
await settle(200);
await shot("26b-comments-panel");
console.log("comments panel:", JSON.stringify(await commentCards().evaluateAll((cards) => cards.map((c) => c.innerText.replace(/\s+/g, " ").trim()))));
await commentCards().first().getByRole("button", { name: "Resolve comment" }).click();
await settle(200);
console.log("after resolve, cards:", await commentCards().count(), "· Markdown:", JSON.stringify((await editorText()).split("\n").find((l) => l.includes("works as usual"))));
await page.getByText("Show resolved").click();
console.log("with resolved shown, cards:", await commentCards().count());
await commentCards().nth(1).getByRole("button", { name: "Delete comment" }).click();
await settle(200);
console.log("after delete:", await commentCards().count(), "card(s) · text kept:", (await editorText()).includes("and labeled display equations are numbered"));
await modeButton("Writing").click();
await page.locator(".cm-line", { hasText: "Raw LaTeX passes" }).click({ position: { x: 60, y: 8 } });
await page.locator(".pf-comment-marker").first().waitFor({ timeout: 5000 });
await page.locator(".pf-comment").first().scrollIntoViewIfNeeded();
await page.locator(".pf-comment").first().hover();
await settle(1200);
await shot("26c-comment-writing-mode");
console.log(
  "writing mode: highlighted",
  JSON.stringify(await page.locator(".pf-comment").allTextContents()),
  "· marker title",
  JSON.stringify(await page.locator(".pf-comment-marker").first().getAttribute("title")),
);
await page.locator(".pf-comment-marker").first().click();
const editBox = page.getByRole("dialog", { name: "Edit comment" });
await editBox.waitFor({ timeout: 5000 });
await shot("26d-comment-edit-box");
await editBox.getByRole("button", { name: "Reopen" }).click();
await settle(200);
console.log("reopened from the marker:", !(await editorText()).includes("resolved=true"));
await modeButton("Source").click();
await settle(200);
await page.getByRole("button", { name: "Review", exact: true }).click();
await page.waitForFunction(() => window.__pfCalls.some((c) => c.cmd === "compile" && c.args.review === true), null, { timeout: 5000 });
await settle(600);
await shot("26e-review-mode");
const reviewCompiles = await page.evaluate(() => window.__pfCalls.filter((c) => c.cmd === "compile").slice(-1).map((c) => c.args));
console.log("review toggle compile:", JSON.stringify(reviewCompiles), "· preview badge:", await page.getByText("Review PDF", { exact: true }).count());
await page.getByRole("button", { name: "Export" }).click();
await page.getByRole("menuitem", { name: /Review PDF/ }).click();
await page.waitForFunction(() => window.__pfCalls.some((c) => c.cmd === "export_pdf"), null, { timeout: 10000 });
console.log("export review PDF:", JSON.stringify(await page.evaluate(() => window.__pfCalls.filter((c) => c.cmd === "export_pdf").map((c) => c.args))));
await page.getByRole("button", { name: "Review", exact: true }).click();
await settle(600);
console.log("review off, last compile review:", await page.evaluate(() => window.__pfCalls.filter((c) => c.cmd === "compile").at(-1).args.review));

// Track changes: with the toolbar toggle on, typed text becomes an insertion and backspaced text
// a deletion; the Review panel accepts one and rejects the other; Mod-Z takes back a tracked edit
// in one step; Review compiles with `review`.
const placeCursor = (after) =>
  page.evaluate(async (after) => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("@codemirror_view"));
    const { EditorView } = await import(url);
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    const at = view.state.doc.toString().indexOf(after) + after.length;
    view.dispatch({ selection: { anchor: at } });
    view.focus();
  }, after);
const rawLine = async () => (await editorText()).split("\n").find((l) => l.startsWith("Raw LaTeX"));
const trackButton = page.getByRole("button", { name: "Track changes", exact: true });
await trackButton.click();
await settle(200);
console.log(
  "track changes toggle:",
  await trackButton.getAttribute("aria-pressed"),
  "· stored:",
  JSON.stringify(await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("paperforge.trackChanges:")))),
);
await placeCursor("untouched");
await page.keyboard.type(" and safe", { delay: 20 });
await placeCursor("untouched and safe]");
await settle(100);
const afterTyping = await rawLine();
await placeCursor("when");
for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
await settle(200);
console.log("tracked Markdown:", JSON.stringify(await rawLine()), "· after typing:", JSON.stringify(afterTyping));
await page.keyboard.press("ControlOrMeta+z");
await settle(200);
console.log("undo takes back the tracked deletion:", JSON.stringify(await rawLine()));
await page.keyboard.press("ControlOrMeta+Shift+z");
await settle(200);
console.log("redo:", JSON.stringify(await rawLine()));
await modeButton("Writing").click();
await page.locator(".cm-line", { hasText: "Inline math works" }).click({ position: { x: 60, y: 8 } });
await page.locator(".pf-insertion").first().waitFor({ timeout: 5000 });
await page.locator(".pf-insertion").first().scrollIntoViewIfNeeded();
await page.locator(".pf-insertion").first().hover();
await page.getByRole("group", { name: "Tracked change" }).waitFor({ timeout: 5000 });
await shot("27-track-changes-writing");
console.log(
  "writing mode changes: inserted",
  JSON.stringify(await page.locator(".pf-insertion").allTextContents()),
  "· deleted",
  JSON.stringify(await page.locator(".pf-deletion").allTextContents()),
  "· raw line shown:",
  JSON.stringify(await page.locator(".cm-line", { hasText: "Raw LaTeX" }).first().textContent()),
);
await modeButton("Source").click();
await settle(200);
await page.getByRole("tab", { name: "Review", exact: true }).click();
const changeCards = (kind) => page.getByRole("listitem", { name: new RegExp(`^${kind} by `) });
await changeCards("Insertion").first().waitFor({ timeout: 5000 });
await settle(200);
await shot("27b-review-panel");
console.log(
  "review panel changes:",
  JSON.stringify(await page.getByRole("region", { name: "Changes" }).getByRole("listitem").evaluateAll((cards) => cards.map((c) => c.innerText.replace(/\s+/g, " ").trim()))),
);
await page.getByRole("button", { name: "Review", exact: true }).click();
await page.waitForFunction(() => window.__pfCalls.filter((c) => c.cmd === "compile").at(-1)?.args.review === true, null, { timeout: 5000 });
console.log("review compile with tracked changes:", JSON.stringify(await page.evaluate(() => window.__pfCalls.filter((c) => c.cmd === "compile").at(-1).args)));
await page.getByRole("button", { name: "Review", exact: true }).click();
await settle(300);
await changeCards("Insertion").first().getByRole("button", { name: "Accept change" }).click();
await settle(200);
await changeCards("Deletion").first().getByRole("button", { name: "Reject change" }).click();
await settle(200);
console.log("after accept insertion and reject deletion:", JSON.stringify(await rawLine()), "· cards left:", await changeCards("(Insertion|Deletion)").count());
await trackButton.click();
await settle(200);
console.log("track changes off:", await trackButton.getAttribute("aria-pressed"));
await page.getByRole("tab", { name: "Structure", exact: true }).click();

// Version history: with history off the tab offers to enable it; then the timeline groups days,
// folds autosaves and shows labels; Save version names a milestone (toolbar and Mod-Shift-S);
// the compare view covers the editor, restores a part and closes with Close or Escape.
const historyCalls = (cmd) => page.evaluate((cmd) => window.__pfCalls.filter((c) => c.cmd === cmd).map((c) => c.args), cmd);
await page.evaluate(() => (window.__pfHistory.enabled = false));
await page.getByRole("tab", { name: "History", exact: true }).click();
await page.getByRole("button", { name: "Enable version history" }).waitFor({ timeout: 5000 });
await settle(200);
await shot("28a-history-off");
await page.getByRole("button", { name: "Enable version history" }).click();
const timelineGroup = page.getByRole("group", { name: "Version history" });
await timelineGroup.waitFor({ timeout: 5000 });
await settle(300);
console.log("history enabled from the banner:", (await historyCalls("history_enable")).length === 1);
await timelineGroup.getByRole("button", { name: /^3 autosaves/ }).click();
await settle(200);
await shot("28b-history-panel");
console.log(
  "history timeline:",
  JSON.stringify(
    await timelineGroup.locator("section").evaluateAll((sections) =>
      sections.map((s) => `${s.getAttribute("aria-label")}: ${[...s.querySelectorAll(":scope > ol > li")].map((li) => li.getAttribute("aria-label") ?? li.querySelector("button").innerText.replace(/\s+/g, " ")).join(", ")}`),
    ),
  ),
);
console.log("status bar:", await page.locator("footer").getByRole("button", { name: /^Last version/ }).textContent());

await page.getByRole("button", { name: "Save version", exact: true }).click();
const saveDialog = page.getByRole("dialog", { name: "Save version" });
await saveDialog.getByPlaceholder("e.g. Sent to reviewer").fill("Sent to reviewer");
await saveDialog.getByPlaceholder(/What changed/).fill("To Prof. Smith, with the new experiment");
await shot("28c-save-version");
await saveDialog.getByRole("button", { name: "Save version" }).click();
await timelineGroup.getByText("Sent to reviewer").waitFor({ timeout: 5000 });
await saveDialog.waitFor({ state: "detached" });
console.log(
  "save version:",
  JSON.stringify(await historyCalls("history_save_version")),
  "· status bar:",
  await page.locator("footer").getByRole("button", { name: /^Last version/ }).getAttribute("title"),
);
await page.keyboard.press("ControlOrMeta+Shift+s");
await saveDialog.waitFor({ timeout: 5000 });
await page.keyboard.press("Escape");
await saveDialog.waitFor({ state: "detached" });
console.log("Mod-Shift-S opened and Escape closed the save version dialog");

const versionRow = (n) => timelineGroup.getByRole("listitem", { name: /^Version / }).nth(n);
const compareView = page.getByRole("region", { name: "Compare versions" });
await versionRow(1).hover();
await versionRow(1).getByRole("button", { name: /^Actions for/ }).click();
await shot("28d-history-actions");
await page.getByRole("menuitem", { name: "Compare with current" }).click();
await compareView.getByRole("region", { name: "Method" }).waitFor({ timeout: 5000 });
await settle(300);
await shot("28e-history-compare");
console.log(
  "compare:",
  JSON.stringify(await compareView.locator("span").first().innerText()),
  "· cards",
  JSON.stringify(await compareView.locator("section").evaluateAll((s) => s.map((x) => x.getAttribute("aria-label")))),
  "· ins",
  JSON.stringify(await compareView.locator("ins").allTextContents()),
  "· del",
  JSON.stringify(await compareView.locator("del").allTextContents()),
  "· folds",
  JSON.stringify(await compareView.getByRole("button", { name: /^Show \d+/ }).allTextContents()),
  "· editor still mounted:",
  await page.locator(".cm-editor").count(),
);
console.log("compare lists:", JSON.stringify(await compareView.locator("section ul").allInnerTexts()));
const foldsBefore = await compareView.getByRole("button", { name: /unchanged word/ }).count();
await compareView.getByRole("button", { name: /unchanged word/ }).first().click();
console.log("unchanged runs folded:", foldsBefore, "→ after expanding one:", await compareView.getByRole("button", { name: /unchanged word/ }).count());
const notesCard = compareView.getByRole("region", { name: "Notes" });
await notesCard.getByRole("button", { name: "Restore this part" }).click();
await notesCard.getByRole("alertdialog").getByRole("button", { name: "Restore" }).click();
await notesCard.waitFor({ state: "detached", timeout: 5000 });
console.log(
  "restore part:",
  JSON.stringify(await historyCalls("history_restore_part")),
  "· part switcher:",
  await page.getByRole("button", { name: /^All chapters/ }).getAttribute("aria-label"),
);
await compareView.getByRole("button", { name: "Close" }).click();
await compareView.waitFor({ state: "detached" });
console.log("compare closed, editor visible:", await page.locator(".cm-editor").isVisible());

await versionRow(1).getByRole("button").first().click();
await compareView.waitFor({ timeout: 5000 });
const viewed = (await historyCalls("history_diff")).at(-1);
await page.keyboard.press("Escape");
await compareView.waitFor({ state: "detached" });
console.log("view changes diffed", viewed.from.slice(0, 7), "→", viewed.to?.slice(0, 7), "· Escape closed the compare view");

await versionRow(2).hover();
await versionRow(2).getByRole("button", { name: /^Actions for/ }).click();
await page.getByRole("menuitem", { name: /^Restore this version/ }).click();
await page.getByRole("alertdialog", { name: "Restore version" }).getByRole("button", { name: "Restore" }).click();
await page.waitForFunction(() => window.__pfCalls.some((c) => c.cmd === "history_restore"), null, { timeout: 5000 });
await settle(300);
console.log("restore version:", JSON.stringify(await historyCalls("history_restore")));
await page.getByRole("tab", { name: "Structure", exact: true }).click();
await page.locator("footer").getByRole("button", { name: /^Last version/ }).click();
console.log("status bar opens the History tab:", await page.getByRole("tab", { name: "History", exact: true }).getAttribute("aria-selected"));
await page.getByRole("tab", { name: "Structure", exact: true }).click();

// Typing cost: main-thread time per keystroke (CodeMirror update + save scheduling + React),
// on one part and on a part 20x longer, with the cursor in view, in Source and Writing mode.
await editorTabs().first().click();
await settle(300);
async function typingCost(repeat, tracked = false) {
  return page.evaluate(async ({ repeat, tracked }) => {
    // The same pre-bundled module instance the app loaded, so findFromDOM sees its views.
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("@codemirror_view"));
    const { EditorView } = await import(url);
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    const original = view.state.doc.toString();
    if (repeat > 1) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: Array(repeat).fill(original).join("\n\n") } });
      await new Promise((r) => setTimeout(r, 500));
    }
    const middle = Math.floor(view.state.doc.length / 2);
    view.dispatch({ selection: { anchor: middle }, effects: EditorView.scrollIntoView(middle, { y: "center" }) });
    await new Promise((r) => setTimeout(r, 300));
    const sync = [];
    let longTasks = 0;
    const po = new PerformanceObserver((list) => (longTasks += list.getEntries().length));
    po.observe({ type: "longtask" });
    for (let i = 0; i < 300; i++) {
      const t = performance.now();
      const spec = view.state.replaceSelection(i % 40 === 39 ? "\n" : "x");
      view.dispatch(tracked ? { ...spec, userEvent: "input.type" } : spec);
      sync.push(performance.now() - t);
      if (i % 10 === 0) await new Promise((r) => requestAnimationFrame(r));
    }
    await new Promise((r) => setTimeout(r, 300));
    po.disconnect();
    sync.sort((a, b) => a - b);
    const lines = view.state.doc.lines;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: original } });
    await new Promise((r) => setTimeout(r, 300));
    return { lines, p50: sync[150].toFixed(2), p95: sync[285].toFixed(2), max: sync[299].toFixed(2), longTasks };
  }, { repeat, tracked });
}
for (const mode of ["Source", "Writing"]) {
  await modeButton(mode).click();
  await settle(300);
  console.log(`typing, ${mode} mode, one part (ms/keystroke):`, JSON.stringify(await typingCost(1)));
  console.log(`typing, ${mode} mode, 20x part (ms/keystroke):`, JSON.stringify(await typingCost(20)));
}
// The same keystrokes as typed input with Track changes on, so each one goes through tracking.
await trackButton.click();
for (const mode of ["Source", "Writing"]) {
  await modeButton(mode).click();
  await settle(300);
  console.log(`typing tracked, ${mode} mode, one part (ms/keystroke):`, JSON.stringify(await typingCost(1, true)));
  console.log(`typing tracked, ${mode} mode, 20x part (ms/keystroke):`, JSON.stringify(await typingCost(20, true)));
}
await trackButton.click();
await modeButton("Source").click();
await settle(800);

// Closing the window or quitting: pending edits are saved, the session becomes a version, then the app quits.
await page.click(".cm-content");
await page.keyboard.type(" Typed right before quitting.");
await page.evaluate(() => window[`_${window.__pfListeners["quit-requested"]}`]({ event: "quit-requested", id: 0, payload: null }));
await page.waitForFunction(() => window.__pfCalls.some((c) => c.cmd === "app_quit"), null, { timeout: 6000 });
const quitCalls = (await page.evaluate(() => window.__pfCalls.map((c) => c.cmd)))
  .filter((cmd) => ["part_save", "history_save_version", "app_quit"].includes(cmd))
  .slice(-3);
console.log("quit:", quitCalls.join(" → "), "· session:", JSON.stringify((await historyCalls("history_save_version")).at(-1).reason));

const calls = await page.evaluate(() => window.__pfCalls);
console.log("IPC calls:", [...new Set(calls.map((c) => c.cmd))].join(", "));
console.log("compile focus values:", [...new Set(calls.filter((c) => c.cmd === "compile").map((c) => String(c.args.focus)))].join(", "));
console.log(errors.length ? `Page errors:\n${errors.join("\n")}` : "No page errors");
await browser.close();
