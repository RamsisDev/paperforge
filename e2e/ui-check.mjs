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
        case "dictionary_read":
          return state.dictionary ?? [];
        case "dictionary_add":
          state.dictionary = [...new Set([...(state.dictionary ?? []), ...args.words])];
          return state.dictionary;
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
await page.keyboard.press("Escape");
await page.keyboard.type("\n\n/to");
await page.waitForSelector(".cm-tooltip-autocomplete", { timeout: 5000 });
await shot("13-slash-toc");
await page.keyboard.press("Escape");

// KaTeX hover, in the method chapter.
await page.locator("li.group").nth(1).click();
await settle(300);
await page.locator(".pf-math").first().hover();
await page.waitForSelector(".pf-math-tooltip .katex", { timeout: 5000 });
await shot("14-math-hover");

await page.getByRole("tab", { name: "Refs", exact: true }).click();
await settle(200);
await shot("15-references");
await page.getByRole("tab", { name: "Figures", exact: true }).click();
await settle(500);

// Double-click a word in the PDF: the editor opens the part with that sentence.
await page.getByRole("tab", { name: "Structure", exact: true }).click();
await page.locator(".pf-page").first().scrollIntoViewIfNeeded();
const span = page.locator(".textLayer span", { hasText: "measured" }).first();
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

// Typing cost: main-thread time per keystroke (CodeMirror update + save scheduling + React),
// on one part and on a part 20x longer.
await editorTabs().first().click();
await settle(300);
async function typingCost(repeat) {
  return page.evaluate(async (repeat) => {
    // The same pre-bundled module instance the app loaded, so findFromDOM sees its views.
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("@codemirror_view"));
    const { EditorView } = await import(url);
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    if (repeat > 1) {
      const doc = view.state.doc.toString();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: Array(repeat).fill(doc).join("\n\n") } });
      await new Promise((r) => setTimeout(r, 500));
    }
    view.dispatch({ selection: { anchor: Math.floor(view.state.doc.length / 2) } });
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
    return { lines, p50: sync[150].toFixed(2), p95: sync[285].toFixed(2), max: sync[299].toFixed(2), longTasks };
  }, repeat);
}
console.log("typing, one part (ms/keystroke):", JSON.stringify(await typingCost(1)));
console.log("typing, 20x part (ms/keystroke):", JSON.stringify(await typingCost(20)));
await settle(800);

const calls = await page.evaluate(() => window.__pfCalls);
console.log("IPC calls:", [...new Set(calls.map((c) => c.cmd))].join(", "));
console.log("compile focus values:", [...new Set(calls.filter((c) => c.cmd === "compile").map((c) => String(c.args.focus)))].join(", "));
console.log(errors.length ? `Page errors:\n${errors.join("\n")}` : "No page errors");
await browser.close();
