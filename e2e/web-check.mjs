#!/usr/bin/env node
// Browser mode against the real backend (no IPC stub): `npm run web -- <project>` must be running.
// Usage: node e2e/web-check.mjs <project-dir> <out-dir>

import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [projectDir, outDir] = process.argv.slice(2);
if (!projectDir || !outDir) {
  console.error("usage: node e2e/web-check.mjs <project-dir> <out-dir>");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`) });
const pdfPath = join(projectDir, ".build", "paper.pdf");
const mtime = () => statSync(pdfPath, { throwIfNoEntry: false })?.mtimeMs ?? 0;

await page.goto("http://localhost:1420/");
await page.waitForSelector(".cm-content", { timeout: 20000 });
await page.waitForSelector(".pf-page canvas", { timeout: 60000 });
await page.waitForTimeout(500);
await shot("01-opened");
console.log("title:", await page.title());

const before = mtime();
await page.click(".cm-content");
await page.keyboard.press("ControlOrMeta+End");
await page.keyboard.type("\n\nTyped in the browser, compiled by the real backend.");
const started = Date.now();
while (mtime() === before && Date.now() - started < 20000) await page.waitForTimeout(100);
console.log(mtime() > before ? `recompiled after edit in ${Date.now() - started} ms` : "NO RECOMPILE");
await page.waitForTimeout(1500);
await shot("02-after-edit");

const [download] = await Promise.all([
  page.waitForEvent("download", { timeout: 30000 }),
  page.getByRole("button", { name: /Export/ }).click().then(() => page.getByRole("menuitem", { name: /^PDF/ }).click()),
]);
console.log("downloaded:", download.suggestedFilename());

await page.getByRole("button", { name: "Close project" }).click();
await page.getByText("Open paper…").click();
await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
await page.waitForTimeout(500);
await shot("03-folder-picker");
console.log("folder picker shows:", (await page.locator('[role="dialog"] li').count()) - 1, "entries");

console.log(errors.length ? `Page errors:\n${errors.join("\n")}` : "No page errors");
await browser.close();
