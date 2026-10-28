#!/usr/bin/env node
// Drives the real frontend (from the running `npm run tauri dev` Vite server) in headless Chrome,
// with Tauri's IPC replaced by a stub that serves a real project folder and its compiled PDF.
//
// Usage: node e2e/ui-check.mjs <project-dir> <out-dir>
//   The project must have been compiled once (by the app or `npm run warm-tex-cache`).

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [projectDir, outDir] = process.argv.slice(2);
if (!projectDir || !outDir) {
  console.error("usage: node e2e/ui-check.mjs <project-dir> <out-dir>");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const snapshot = {
  dir: projectDir,
  meta: JSON.parse(readFileSync(join(projectDir, "paper.json"), "utf8")),
  body: readFileSync(join(projectDir, "paper.md"), "utf8"),
  bib: readFileSync(join(projectDir, "refs.bib"), "utf8"),
  figures: ["figures/example.png"],
};

function stubTauri(snapshot) {
  const calls = [];
  window.__pfCalls = calls;
  let id = 0;
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
      calls.push(cmd);
      const file = (p) => fetch(`http://files.local${p}`);
      switch (cmd) {
        case "startup_project":
          return snapshot.dir;
        case "project_open":
          return snapshot;
        case "project_save":
          return null;
        case "figure_list":
          return snapshot.figures;
        case "compile":
          await new Promise((r) => setTimeout(r, 300));
          return {
            ok: true,
            cancelled: false,
            pdfPath: `${snapshot.dir}/.build/paper.pdf`,
            pandocMs: 180,
            texMs: 610,
            usedNetwork: false,
            needsRerun: false,
            diagnostics: [
              { severity: "warning", stage: "latex", message: "Citation `missing2020' on page 1 undefined", file: "paper.tex", line: 46, source: "Cite with \\citep{knuth1984, lamport1994} or in the text: \\citet{shannon1948} showed that" },
              { severity: "warning", stage: "bibtex", message: "empty journal in shannon1948", file: null, line: null, source: null },
            ],
          };
        case "read_binary":
          return (await file(args.path)).arrayBuffer();
        case "read_tex":
          return (await file(`${snapshot.dir}/.build/paper.tex`)).text();
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
await page.addInitScript(stubTauri, snapshot);

const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`) });

await page.goto("http://localhost:1420/");
await page.waitForSelector(".cm-content", { timeout: 15000 });
await page.waitForSelector(".pf-page canvas", { timeout: 15000 });
await page.waitForTimeout(800);
await shot("01-workspace");

// Type a citation: the autocomplete lists bib entries.
await page.click(".cm-content");
await page.keyboard.press("ControlOrMeta+End");
await page.keyboard.type("\n\nAs shown by @sha");
await page.waitForSelector(".cm-tooltip-autocomplete", { timeout: 5000 });
await shot("02-cite-autocomplete");
await page.keyboard.press("Escape");

// Slash commands.
await page.keyboard.type("\n\n/ta");
await page.waitForSelector(".cm-tooltip-autocomplete", { timeout: 5000 });
await shot("03-slash-commands");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);

// Hover inline math for the KaTeX preview.
const math = page.locator(".pf-math").first();
await math.hover();
await page.waitForSelector(".pf-math-tooltip .katex", { timeout: 5000 });
await shot("04-math-hover");

// Problems panel and a jump from a diagnostic to its Markdown line.
await page.keyboard.press("ControlOrMeta+j");
await page.waitForTimeout(200);
await page.getByText("Citation `missing2020'").click();
await page.waitForTimeout(400);
await shot("05-problems");

// Sidebar tabs.
await page.getByRole("tab", { name: "Refs", exact: true }).click();
await page.waitForTimeout(200);
await shot("06-references");
await page.getByRole("tab", { name: "Outline", exact: true }).click();
await page.waitForTimeout(200);
await page.getByRole("tab", { name: "Figures", exact: true }).click();
await page.waitForTimeout(500);
await shot("07-figures");

// Double-click a word in the PDF: the editor jumps to that sentence.
await page.getByRole("tab", { name: "Paper", exact: true }).click();
const span = page.locator(".textLayer span", { hasText: "measured" }).first();
await span.dblclick();
await page.waitForTimeout(500);
const activeLine = await page.locator(".cm-activeLine").first().textContent();
console.log("PDF double-click jumped to line:", activeLine);

// Dark theme.
await page.getByRole("button", { name: "Dark theme" }).click();
await page.waitForTimeout(400);
await shot("08-dark");

// Generated LaTeX tab.
await page.getByRole("tab", { name: "paper.tex (generated)" }).click();
await page.waitForTimeout(400);
await shot("09-generated-tex");

// Typing cost: main-thread time per keystroke (CodeMirror update + save scheduling + React),
// on the sample and on a document 20x longer.
await page.getByRole("tab", { name: "paper.md" }).click();
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
console.log("typing, sample  (ms/keystroke):", JSON.stringify(await typingCost(1)));
console.log("typing, 20x doc (ms/keystroke):", JSON.stringify(await typingCost(20)));

const calls = await page.evaluate(() => window.__pfCalls);
console.log("IPC calls:", [...new Set(calls)].join(", "));
console.log(errors.length ? `Page errors:\n${errors.join("\n")}` : "No page errors");
await browser.close();
