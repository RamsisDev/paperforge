import {
  Bold,
  BookOpen,
  ChevronDown,
  Code,
  FileArchive,
  FileDown,
  FolderOpen,
  Heading1,
  Heading2,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  LoaderCircle,
  LogOut,
  Moon,
  PanelLeft,
  Play,
  Quote,
  Sigma,
  SquareFunction,
  Sun,
  Superscript,
  Table,
} from "lucide-react";
import type { ReactNode } from "react";
import { exportLatex, exportPdf, revealProject } from "@/actions";
import { formatting } from "@/editor/commands";
import { withEditor } from "@/editor/bridge";
import { baseName } from "@/lib/api";
import { TEMPLATES } from "@/lib/templates";
import { closeProject, compileNow, updateMeta } from "@/session";
import { setTheme, store, useStore } from "@/store";
import { notify } from "./Toaster";
import { Button, IconButton, MOD, Menu, SHIFT, Select } from "./ui";

type Action = keyof typeof formatting;

const GROUPS: { action: Action; label: string; icon: ReactNode; shortcut?: string }[][] = [
  [
    { action: "h1", label: "Section", icon: <Heading1 size={15} />, shortcut: `${MOD}⌥1` },
    { action: "h2", label: "Subsection", icon: <Heading2 size={15} />, shortcut: `${MOD}⌥2` },
  ],
  [
    { action: "bold", label: "Bold", icon: <Bold size={15} />, shortcut: `${MOD}B` },
    { action: "italic", label: "Italic", icon: <Italic size={15} />, shortcut: `${MOD}I` },
    { action: "superscript", label: "Superscript", icon: <Superscript size={15} /> },
    { action: "code", label: "Inline code", icon: <Code size={15} />, shortcut: `${MOD}E` },
    { action: "link", label: "Link", icon: <Link size={15} />, shortcut: `${MOD}K` },
  ],
  [
    { action: "bullet", label: "Bulleted list", icon: <List size={15} /> },
    { action: "numbered", label: "Numbered list", icon: <ListOrdered size={15} /> },
    { action: "quote", label: "Quote", icon: <Quote size={15} /> },
  ],
  [
    { action: "math", label: "Inline math", icon: <Sigma size={15} />, shortcut: `${MOD}M` },
    { action: "equation", label: "Numbered equation", icon: <SquareFunction size={15} />, shortcut: `${MOD}${SHIFT}M` },
    { action: "citation", label: "Citation", icon: <BookOpen size={15} />, shortcut: `${MOD}${SHIFT}C` },
    { action: "figure", label: "Figure", icon: <Image size={15} /> },
    { action: "table", label: "Table", icon: <Table size={15} /> },
  ],
];

function run(task: () => Promise<unknown>) {
  task().catch((e) => notify(String(e), "error"));
}

export function Toolbar() {
  const dir = useStore((s) => s.dir);
  const meta = useStore((s) => s.meta);
  const theme = useStore((s) => s.theme);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const compiling = useStore((s) => s.compile.state === "running");
  const editingMarkdown = useStore((s) => s.activeFile === "paper.md");

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
      <IconButton
        label="Toggle sidebar"
        shortcut={`${MOD}\\`}
        active={sidebarOpen}
        onClick={() => store.set((s) => ({ sidebarOpen: !s.sidebarOpen }))}
      >
        <PanelLeft size={16} />
      </IconButton>
      <div className="min-w-0 max-w-56 px-1">
        <div className="truncate text-[13px] font-semibold text-fg">{meta?.title || "Untitled"}</div>
        <div className="truncate text-[11px] text-faint">{dir ? baseName(dir) : ""}</div>
      </div>

      <div className="mx-1 h-5 w-px bg-line" />
      <div className="flex min-w-0 items-center gap-0.5 overflow-hidden">
        {GROUPS.map((group, i) => (
          // Lists collapse first on narrow windows; they are one keystroke away anyway.
          <div key={i} className={i === 2 ? "hidden items-center gap-0.5 xl:flex" : "flex items-center gap-0.5"}>
            {i > 0 && <div className="mx-1 h-4 w-px bg-line" />}
            {group.map((b) => (
              <IconButton
                key={b.action}
                label={b.label}
                shortcut={b.shortcut}
                disabled={!editingMarkdown}
                onClick={() => withEditor(formatting[b.action])}
              >
                {b.icon}
              </IconButton>
            ))}
          </div>
        ))}
      </div>

      <div className="flex-1" />
      {meta && (
        <Select
          aria-label="Template"
          className="w-40 shrink-0"
          value={meta.template}
          onChange={(e) => updateMeta({ template: e.target.value as typeof meta.template })}
        >
          {TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </Select>
      )}
      <Button variant="primary" onClick={() => run(() => compileNow("full"))} title={`Save and typeset (${MOD}S)`}>
        {compiling ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />}
        Typeset
      </Button>
      <Menu
        trigger={
          <Button>
            <FileDown size={14} /> Export <ChevronDown size={13} className="text-faint" />
          </Button>
        }
        items={[
          { label: "PDF…", icon: <FileDown size={14} />, shortcut: `${MOD}${SHIFT}E`, onSelect: () => run(exportPdf) },
          { label: "LaTeX sources (.zip)…", icon: <FileArchive size={14} />, onSelect: () => run(exportLatex) },
          { label: "Show project folder", icon: <FolderOpen size={14} />, onSelect: () => run(revealProject) },
        ]}
      />
      <IconButton label={theme === "dark" ? "Light theme" : "Dark theme"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
        {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      </IconButton>
      <IconButton label="Close project" onClick={() => run(closeProject)}>
        <LogOut size={15} />
      </IconButton>
    </header>
  );
}
