#!/usr/bin/env node
// Runs PaperForge in the browser: the Rust backend over HTTP (127.0.0.1:1430) plus Vite (1420).
// Usage: npm run web [-- <project-dir>]

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
delete env.CARGO_TARGET_DIR;

const children = [
  spawn(
    "cargo",
    ["run", "--quiet", "--features", "web", "--bin", "paperforge-web", "--", ...process.argv.slice(2)],
    { cwd: join(root, "src-tauri"), stdio: "inherit", env },
  ),
  spawn("npx", ["vite", "--open"], { cwd: root, stdio: "inherit", env, shell: process.platform === "win32" }),
];

function stop(code) {
  for (const child of children) child.kill();
  process.exit(code);
}
for (const child of children) child.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
