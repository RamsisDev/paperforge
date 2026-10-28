import { notify } from "@/components/Toaster";
import { api, baseName, joinPath, type TemplateId } from "@/lib/api";
import { pickFolder, revealInFileManager, saveOutput } from "@/lib/platform";
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

async function freshBuild(review = false): Promise<boolean> {
  const ok = await compileNow("full", review);
  if (!ok) {
    notify("The paper has errors; fix them before exporting.", "error");
    store.set({ problemsOpen: true });
  }
  return ok;
}

export async function exportPdf() {
  const { dir, meta } = store.get();
  if (!dir || !(await freshBuild())) return;
  const saved = await saveOutput({
    defaultName: `${slug(meta?.title ?? "paper")}.pdf`,
    label: "PDF",
    extension: "pdf",
    write: (dest) => api.exportPdf(dir, dest),
    read: () => api.readBinary(joinPath(dir, ".build/paper.pdf")),
  });
  if (saved) notify(`Saved ${baseName(saved)}`);
}

/** The review PDF: comments highlighted with their notes, tracked changes marked. */
export async function exportReviewPdf() {
  const { dir, meta } = store.get();
  if (!dir || !(await freshBuild(true))) return;
  const saved = await saveOutput({
    defaultName: `${slug(meta?.title ?? "paper")}-review.pdf`,
    label: "PDF",
    extension: "pdf",
    write: (dest) => api.exportPdf(dir, dest, true),
    read: () => api.readBinary(joinPath(dir, ".build/review/paper.pdf")),
  });
  if (saved) notify(`Saved ${baseName(saved)}`);
}

export async function exportLatex() {
  const { dir, meta } = store.get();
  if (!dir || !(await freshBuild())) return;
  const staged = joinPath(dir, ".build/export.zip");
  const saved = await saveOutput({
    defaultName: `${slug(meta?.title ?? "paper")}-latex.zip`,
    label: "ZIP archive",
    extension: "zip",
    write: (dest) => api.exportZip(dir, dest),
    read: async () => {
      await api.exportZip(dir, staged);
      return api.readBinary(staged);
    },
  });
  if (saved) notify(`Saved ${baseName(saved)} — ready to upload to Overleaf or a journal`);
}

export async function revealProject() {
  const dir = store.get().dir;
  if (!dir) return;
  if (!(await revealInFileManager(joinPath(dir, "paper.json")))) notify(`Project folder: ${dir}`);
}

export async function openProjectDialog() {
  const dir = await pickFolder({ title: "Open a PaperForge project folder", mode: "open" });
  if (dir) await openProjectAt(dir);
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
  const dir = await pickFolder({
    title: project.sample ? "Choose a folder for the sample paper" : "Choose an empty folder for the new paper",
    mode: "create",
  });
  if (!dir) return false;
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
