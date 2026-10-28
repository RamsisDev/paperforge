import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { notify } from "@/components/Toaster";
import { api, baseName, joinPath, type TemplateId } from "@/lib/api";
import { compileNow, loadProject } from "@/session";
import { store } from "@/store";

function slug(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return s || "paper";
}

async function freshBuild(): Promise<boolean> {
  const ok = await compileNow("full");
  if (!ok) {
    notify("The paper has errors; fix them before exporting.", "error");
    store.set({ problemsOpen: true });
  }
  return ok;
}

export async function exportPdf() {
  const { dir, meta } = store.get();
  if (!dir || !(await freshBuild())) return;
  const dest = await save({
    defaultPath: `${slug(meta?.title ?? "paper")}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!dest) return;
  await api.exportPdf(dir, dest);
  notify(`Saved ${baseName(dest)}`);
}

export async function exportLatex() {
  const { dir, meta } = store.get();
  if (!dir || !(await freshBuild())) return;
  const dest = await save({
    defaultPath: `${slug(meta?.title ?? "paper")}-latex.zip`,
    filters: [{ name: "ZIP archive", extensions: ["zip"] }],
  });
  if (!dest) return;
  await api.exportZip(dir, dest);
  notify(`Saved ${baseName(dest)} — ready to upload to Overleaf or a journal`);
}

export async function revealProject() {
  const dir = store.get().dir;
  if (dir) await revealItemInDir(joinPath(dir, "paper.json"));
}

export async function openProjectDialog() {
  const dir = await open({ directory: true, title: "Open a PaperForge project folder" });
  if (typeof dir === "string") await openProjectAt(dir);
}

export async function openProjectAt(dir: string) {
  try {
    loadProject(await api.openProject(dir));
  } catch (e) {
    notify(String(e), "error");
  }
}

export interface NewProject {
  template: TemplateId;
  title: string;
  language: string;
  sample: boolean;
}

/** Asks for a folder and creates the project there; resolves with whether a project was opened. */
export async function createProjectDialog(project: NewProject): Promise<boolean> {
  const dir = await open({
    directory: true,
    title: project.sample ? "Choose a folder for the sample paper" : "Choose an empty folder for the new paper",
  });
  if (typeof dir !== "string") return false;
  try {
    loadProject(await api.createProject(dir, project.template, project.title, project.language, project.sample));
  } catch (e) {
    const message = String(e);
    if (!message.includes("already contains a project")) {
      notify(message, "error");
      return false;
    }
    notify("That folder already has a paper; opening it.");
    await openProjectAt(dir);
  }
  return true;
}
