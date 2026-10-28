#!/usr/bin/env node
// Builds a multi-part "report" project for ui-check.mjs from the bundled sample: one file per
// `# ` heading under sections/, plus a real PDF typeset with the sidecars and the contents
// LaTeX wrote to the .aux (e2e/fixture-toc.json shape = the compile command's `toc`).
//
// Usage: node e2e/make-fixture.mjs [out-dir=/tmp/pf-multipart]

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? "/tmp/pf-multipart");
// The single-file MVP commit's sample and templates: stable while the backend changes.
const BASELINE = "192cdd4";
const head = (path) => execFileSync("git", ["show", `${BASELINE}:${path}`], { cwd: root, encoding: "utf8" });
const sample = "src-tauri/resources/sample";
const templates = "src-tauri/resources/templates";
const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (\S+)/)?.[1] ?? "aarch64-apple-darwin";
const pandoc = join(root, `src-tauri/binaries/pandoc-${triple}`);
const tectonic = join(root, `src-tauri/binaries/tectonic-${triple}`);
const BUNDLE = "https://data1.fullyjustified.net/tlextras-2022.0r0.tar";

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "sections"), { recursive: true });
mkdirSync(join(out, ".build"), { recursive: true });
cpSync(join(root, sample, "figures"), join(out, "figures"), { recursive: true });
writeFileSync(join(out, "refs.bib"), head(`${sample}/refs.bib`));

// One part per top-level heading.
const chunks = [];
for (const line of head(`${sample}/paper.md`).split("\n")) {
  if (line.startsWith("# ") || chunks.length === 0) chunks.push([]);
  chunks.at(-1).push(line);
}
const parts = chunks.map((lines) => {
  const title = lines[0].replace(/^#\s+/, "").replace(/\s*\{[^}]*\}\s*$/, "");
  const file = `sections/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.md`;
  const content = `${lines.join("\n").trim()}\n`;
  writeFileSync(join(out, file), content);
  return { file, content };
});

const sampleMeta = JSON.parse(head(`${sample}/paper.json`));
const meta = {
  ...sampleMeta,
  template: "report",
  bibStyle: "",
  parts: parts.map((p) => p.file),
  toc: true,
  lof: true,
  lot: true,
  tocDepth: 2,
};
writeFileSync(join(out, "paper.json"), `${JSON.stringify(meta, null, 2)}\n`);

// A stand-in for the backend's report template: the article template on the report class.
const tpl = join(out, ".build/tpl");
mkdirSync(tpl, { recursive: true });
writeFileSync(join(tpl, "common.tex"), head(`${templates}/common.tex`));
writeFileSync(join(tpl, "paper.lua"), head(`${templates}/paper.lua`));
const article = head(`${templates}/article.tex`);
writeFileSync(
  join(tpl, "report.tex"),
  article
    .replace("\\documentclass[11pt,a4paper]{article}", "\\documentclass[12pt,a4paper]{report}")
    .replace("$body$", "\\tableofcontents\n\\listoffigures\n\\listoftables\n\n$body$"),
);
writeFileSync(join(out, ".build/paper.md"), parts.map((p) => p.content).join("\n\n"));
writeFileSync(
  join(out, ".build/meta.json"),
  JSON.stringify({
    title: meta.title,
    author: meta.authors.map((a, i) => ({ ...a, n: String(i + 1) })),
    abstract: meta.abstract,
    keywords: meta.keywords,
    "keywords-label": "Keywords",
    lang: "en",
    date: "",
    bibliography: "refs",
  }),
);

execFileSync(
  pandoc,
  [
    ".build/paper.md",
    "--from", "markdown", "--to", "latex", "--standalone", "--natbib", "--wrap=preserve",
    "--top-level-division=chapter",
    `--template=${join(tpl, "report.tex")}`,
    `--lua-filter=${join(tpl, "paper.lua")}`,
    "--metadata-file=.build/meta.json",
    "--output=.build/paper.tex",
  ],
  { cwd: out, stdio: "inherit" },
);
execFileSync(
  tectonic,
  ["--bundle", BUNDLE, "--only-cached", "--keep-logs", "--keep-intermediates", "--chatter", "minimal",
    "--outdir", ".build", "-Z", `search-path=${out}`, ".build/paper.tex"],
  { cwd: out, stdio: "inherit", env: { ...process.env, TECTONIC_CACHE_DIR: join(root, "src-tauri/resources/tex-cache") } },
);
if (!existsSync(join(out, ".build/paper.pdf"))) throw new Error("no PDF");

// \@writefile{toc}{\contentsline {chapter}{\numberline {1}Introduction}{1}{chapter.1}}
const DEPTH = { part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, figure: 1, table: 1 };
/** The brace groups that follow `start` in `s`, balanced. */
function groups(s, start, count) {
  const out = [];
  let i = start;
  while (out.length < count && i < s.length) {
    while (s[i] !== "{" && i < s.length) i++;
    let depth = 0;
    const from = i + 1;
    for (; i < s.length; i++) {
      if (s[i] === "\\") i++;
      else if (s[i] === "{") depth++;
      else if (s[i] === "}" && --depth === 0) break;
    }
    out.push(s.slice(from, i));
    i++;
  }
  return out;
}

const toc = [];
const aux = readFileSync(join(out, ".build/paper.aux"), "utf8");
for (const line of aux.split("\n")) {
  const head = /^\\@writefile\{(toc|lof|lot)\}\{\\contentsline /.exec(line);
  if (!head) continue;
  const [level, text, page] = groups(line, head[0].length, 3);
  const list = head[1];
  const numbered = /^\\numberline \{([^}]*)\}(.*)$/s.exec(text);
  const clean = (s) =>
    s.replace(/\\ignorespaces\s*/g, "").replace(/\\[a-zA-Z]+\s*/g, "").replace(/\\([{}])/g, "$1").replace(/(?<!\\)[{}]/g, "")
      .replace(/\s+/g, " ").trim();
  toc.push({
    list,
    level,
    depth: DEPTH[level] ?? 1,
    number: numbered ? numbered[1] : "",
    title: clean(numbered ? numbered[2] : text),
    page,
  });
}
writeFileSync(join(out, ".build/toc.json"), `${JSON.stringify(toc, null, 2)}\n`);
console.log(`fixture: ${out} (${parts.map((p) => p.file).join(", ")}), ${toc.length} toc entries`);
