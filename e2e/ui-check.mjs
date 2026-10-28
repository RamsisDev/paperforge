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
          return (await file(`${state.dir}/.build/paper.tex`)).text();
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
await modeButton("Source").click();
await settle(200);
console.log(
  "source mode again: widgets",
  await page.locator(".pf-lp-math, .pf-lp-chip, .pf-lp-figure").count(),
  "· math source shown:",
  (await page.locator(".cm-content").textContent()).includes("$$H(X)"),
);

// Typing cost: main-thread time per keystroke (CodeMirror update + save scheduling + React),
// on one part and on a part 20x longer, with the cursor in view, in Source and Writing mode.
await editorTabs().first().click();
await settle(300);
async function typingCost(repeat) {
  return page.evaluate(async (repeat) => {
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
      view.dispatch(view.state.replaceSelection(i % 40 === 39 ? "\n" : "x"));
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
  }, repeat);
}
for (const mode of ["Source", "Writing"]) {
  await modeButton(mode).click();
  await settle(300);
  console.log(`typing, ${mode} mode, one part (ms/keystroke):`, JSON.stringify(await typingCost(1)));
  console.log(`typing, ${mode} mode, 20x part (ms/keystroke):`, JSON.stringify(await typingCost(20)));
}
await modeButton("Source").click();
await settle(800);

const calls = await page.evaluate(() => window.__pfCalls);
console.log("IPC calls:", [...new Set(calls.map((c) => c.cmd))].join(", "));
console.log("compile focus values:", [...new Set(calls.filter((c) => c.cmd === "compile").map((c) => String(c.args.focus)))].join(", "));
console.log(errors.length ? `Page errors:\n${errors.join("\n")}` : "No page errors");
await browser.close();
