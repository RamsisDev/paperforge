#!/usr/bin/env node
// Live collaboration against the real backend: the host shares the paper, one guest joins with
// the link (the frontend served by the host's collaboration port, so `npm run build` first) and
// another types the code; all three type into the same part at once.
// `npm run web -- <project>` must be running.
// Usage: node e2e/collab-check.mjs <project-dir> <out-dir>

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [projectDir, outDir] = process.argv.slice(2);
if (!projectDir || !outDir) {
  console.error("usage: node e2e/collab-check.mjs <project-dir> <out-dir>");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
async function open(name, url) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  await page.goto(url);
  return page;
}
const shot = (page, name) => page.screenshot({ path: join(outDir, `${name}.png`) });
/** The editor's lines without the name labels of other people's cursors. */
const text = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".cm-content .cm-line")]
      .map((line) => {
        const copy = line.cloneNode(true);
        for (const el of copy.querySelectorAll(".cm-ySelectionCaret")) el.remove();
        return copy.textContent;
      })
      .join("\n"),
  );
const check = (label, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
};
async function until(label, condition, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await condition()) return check(`${label} (${Date.now() - started} ms)`, true);
    await new Promise((r) => setTimeout(r, 100));
  }
  check(label, false);
}

const host = await open("host", process.env.PF_URL ?? "http://localhost:1420/");
await host.waitForSelector(".cm-content", { timeout: 20000 });
await host.waitForSelector(".pf-page canvas", { timeout: 90000 });
await host.getByRole("button", { name: "Share" }).click();
const share = host.getByRole("dialog", { name: "Share this paper" });
await share.getByPlaceholder("e.g. Ana").fill("Hana");
await share.getByRole("button", { name: "Start sharing" }).click();
const codeField = share.getByRole("textbox").first();
await codeField.waitFor();
await host.waitForFunction(() => document.querySelectorAll('[role="dialog"] input')[0]?.value.length === 20);
const code = await share.getByRole("textbox").nth(0).inputValue();
const link = await share.getByRole("textbox").nth(1).inputValue();
console.log("code:", code, "· link:", link);
await shot(host, "01-host-sharing");
await share.getByRole("button", { name: "Done" }).click();

// Guest by link: the page comes from the host's collaboration port.
const ana = await open("ana", link);
await ana.getByPlaceholder("e.g. Ana").fill("Ana");
await ana.getByRole("button", { name: "Join", exact: true }).click();
await ana.waitForSelector(".cm-content[contenteditable=true]", { timeout: 20000 });
await ana.waitForSelector(".pf-page canvas", { timeout: 30000 });
check("guest by link sees the host's PDF", true);

// Guest by code, from a page that was not opened with a link.
const port = new URL(link).port;
const bo = await open("bo", `http://127.0.0.1:${port}/`);
await bo.getByPlaceholder("e.g. 60N00J-A1D003-ZGF01A").fill(code.toLowerCase().replaceAll("-", " "));
await bo.getByPlaceholder("e.g. Ana").fill("Bo");
await bo.getByRole("button", { name: "Join", exact: true }).click();
await bo.waitForSelector(".cm-content[contenteditable=true]", { timeout: 20000 });
await until("host lists three people", async () => (await host.locator("header button[title$='in this session'] span span").count()) === 3);

// All three type into the introduction at the same time.
const type = async (page, where, words) => {
  await page.click(".cm-content");
  await page.keyboard.press(where === "end" ? "ControlOrMeta+End" : "ControlOrMeta+Home");
  if (where === "end") await page.keyboard.press("Enter");
  await page.keyboard.type(words, { delay: 15 });
};
await Promise.all([
  type(host, "end", "Hana writes the last line."),
  type(ana, "start", "Ana was here. "),
  type(bo, "end", "Bo adds a sentence too."),
]);
const all = ["Hana writes the last line.", "Ana was here. ", "Bo adds a sentence too."];
for (const [name, page] of [["host", host], ["ana", ana], ["bo", bo]]) {
  await until(`${name} sees every edit`, async () => {
    const t = await text(page);
    return all.every((w) => t.includes(w));
  });
}
const [h, a, b] = await Promise.all([text(host), text(ana), text(bo)]);
check("the three editors converged", h === a && a === b);
if (h !== a || a !== b) console.log(JSON.stringify({ h, a, b }, null, 1));
await until("remote cursors are drawn", async () => (await host.locator(".cm-ySelectionCaret").count()) >= 1, 5000);

const intro = JSON.parse(readFileSync(join(projectDir, "paper.json"), "utf8")).parts[0];
await until("the host wrote the merged text to disk", async () => {
  const disk = readFileSync(join(projectDir, intro), "utf8");
  return all.every((w) => disk.includes(w));
});
await shot(host, "02-host");
await shot(ana, "03-ana");

// The guests' preview follows the host's compile.
const pdfVersion = (page) => page.evaluate(() => document.querySelectorAll(".pf-page canvas").length);
await until("guest's preview shows pages", async () => (await pdfVersion(ana)) > 0);

// A guest's structure change reaches everyone.
const partsOnDisk = () => JSON.parse(readFileSync(join(projectDir, "paper.json"), "utf8")).parts;
const partsBefore = partsOnDisk().length;
await ana.getByRole("button", { name: /Document/ }).click();
await ana.getByRole("menuitem", { name: /^Add / }).click();
await ana.getByPlaceholder(/^New .* title$/).fill("Shared appendix");
await ana.keyboard.press("Enter");
await until("a guest's new part is in paper.json", async () => partsOnDisk().length === partsBefore + 1);
await until("the host's structure shows it", async () => {
  await host.getByRole("tab", { name: "Structure", exact: true }).click();
  return (await host.getByText("Shared appendix").count()) > 0;
});
await until("the other guest's structure shows it", async () => {
  await bo.getByRole("tab", { name: "Structure", exact: true }).click();
  return (await bo.getByText("Shared appendix").count()) > 0;
});

await host.locator("header button[title$='in this session']").click();
await host.getByRole("button", { name: "Stop sharing" }).click();
await until("guests are told the session ended", async () => (await ana.getByText("The host stopped sharing the paper.").count()) > 0);
await until("guests are back on the join screen", async () => (await bo.getByRole("button", { name: "Join", exact: true }).count()) > 0);
await shot(ana, "04-ana-ended");

console.log(errors.length ? `Page errors:\n${errors.join("\n")}` : "No page errors");
await browser.close();
