#!/usr/bin/env node
// Downloads the self-contained Tectonic and Pandoc binaries that ship inside the app as
// Tauri sidecars: src-tauri/binaries/<name>-<target-triple>[.exe].
//
// Usage: node scripts/fetch-sidecars.mjs [target-triple]   (defaults to the host triple)

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TECTONIC_VERSION = "0.17.0";
const PANDOC_VERSION = "3.13";

const TARGETS = {
  "aarch64-apple-darwin": { tectonic: "aarch64-apple-darwin.tar.gz", pandoc: "arm64-macOS.zip" },
  "x86_64-apple-darwin": { tectonic: "x86_64-apple-darwin.tar.gz", pandoc: "x86_64-macOS.zip" },
  "x86_64-unknown-linux-gnu": { tectonic: "x86_64-unknown-linux-musl.tar.gz", pandoc: "linux-amd64.tar.gz" },
  "aarch64-unknown-linux-gnu": { tectonic: "aarch64-unknown-linux-musl.tar.gz", pandoc: "linux-arm64.tar.gz" },
  "x86_64-pc-windows-msvc": { tectonic: "x86_64-pc-windows-msvc.zip", pandoc: "windows-x86_64.zip" },
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "binaries");

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  return /host: (\S+)/.exec(out)[1];
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (entry === name) {
      return p;
    }
  }
  return null;
}

async function fetchTool(tool, url, triple) {
  const exe = triple.includes("windows") ? ".exe" : "";
  const dest = join(outDir, `${tool}-${triple}${exe}`);
  if (existsSync(dest)) {
    console.log(`✓ ${tool} already present: ${dest}`);
    return;
  }
  const work = mkdtempSync(join(tmpdir(), `sidecar-${tool}-`));
  const archive = join(work, url.split("/").pop());
  console.log(`↓ ${url}`);
  await download(url, archive);
  // bsdtar (macOS, Windows 10+) and GNU tar with -a both read .zip and .tar.gz.
  if (archive.endsWith(".zip") && process.platform === "linux") {
    execFileSync("unzip", ["-q", archive, "-d", work]);
  } else {
    execFileSync("tar", ["-xf", archive, "-C", work]);
  }
  const bin = findFile(work, `${tool}${exe}`);
  if (!bin) throw new Error(`${tool}${exe} not found inside ${archive}`);
  copyFileSync(bin, dest);
  if (!exe) chmodSync(dest, 0o755);
  rmSync(work, { recursive: true, force: true });
  console.log(`✓ ${dest}`);
}

const triple = process.argv[2] ?? hostTriple();
const assets = TARGETS[triple];
if (!assets) {
  console.error(`Unsupported target ${triple}. Supported: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
await fetchTool(
  "tectonic",
  `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${assets.tectonic}`,
  triple,
);
await fetchTool(
  "pandoc",
  `https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-${assets.pandoc}`,
  triple,
);
