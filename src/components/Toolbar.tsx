import {
  Asterisk,
  Bold,
  BookOpen,
  ChevronDown,
  Code,
  FileArchive,
  FileDown,
  FilePlus,
  FolderOpen,
  Heading1,
  Heading2,
  Image,
  Images,
  Italic,
  LayoutTemplate,
  Link,
  List,
  ListOrdered,
  LoaderCircle,
  LogOut,
  MessageSquarePlus,
  MessageSquareText,
  Moon,
  PanelLeft,
  Play,
  Quote,
  Scissors,
  Settings2,
  Sigma,
  SquareFunction,
  Sun,
  Superscript,
  Table,
  Table2,
  TableOfContents,
} from "lucide-react";
import type { ReactNode } from "react";
import { exportLatex, exportPdf, exportReviewPdf, revealProject } from "@/actions";
import { formatting } from "@/editor/commands";
import { addComment } from "@/editor/comments";
import { withEditor } from "@/editor/bridge";
import { baseName } from "@/lib/api";
import { splitLevel } from "@/lib/parts";
import { templateInfo, unitName } from "@/lib/templates";
import { closeProject, compileNow, setReviewMode, splitPart } from "@/session";
import {
  askNewPart,
  isPartFile,
  openGallery,
  setEditorMode,
  setTheme,
  showContentsSettings,
  store,
  useStore,
  type EditorMode,
} from "@/store";
import { notify } from "./Toaster";
import { Button, IconButton, MENU_SEPARATOR, MOD, Menu, SHIFT, cx, type MenuItem } from "./ui";

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
    { action: "footnote", label: "Footnote", icon: <Asterisk size={15} /> },
    { action: "figure", label: "Figure", icon: <Image size={15} /> },
    { action: "table", label: "Table", icon: <Table size={15} /> },
  ],
];

function run(task: () => Promise<unknown>) {
  task().catch((e) => notify(String(e), "error"));
}

function splitActivePart() {
  const { parts, activeFile } = store.get();
  const part = parts.find((p) => p.file === activeFile);
  const level = part ? splitLevel(part) : null;
  if (!part || level === null) {
    const unit = unitName(store.get().meta?.template);
    notify(`Nothing to split: this ${unit} needs at least two # or ## headings.`, "error");
    return;
  }
  run(() => splitPart(part.file, level));
}

function addPartAfterActive() {
  const { parts, activeFile } = store.get();
  const index = parts.findIndex((p) => p.file === activeFile);
  askNewPart(index < 0 ? parts.length : index + 1);
}

function documentMenu(template: Parameters<typeof templateInfo>[0], editingMarkdown: boolean): (MenuItem | typeof MENU_SEPARATOR)[] {
  const unit = unitName(template);
  return [
    {
      label: "Change template…",
      icon: <LayoutTemplate size={14} />,
      hint: templateInfo(template).label,
      onSelect: () => openGallery("change"),
    },
    { label: "Contents & lists…", icon: <Settings2 size={14} />, onSelect: showContentsSettings },
    MENU_SEPARATOR,
    {
      label: "Insert table of contents",
      icon: <TableOfContents size={14} />,
      disabled: !editingMarkdown,
      onSelect: () => withEditor(formatting.toc),
    },
    {
      label: "Insert list of figures",
      icon: <Images size={14} />,
      disabled: !editingMarkdown,
      onSelect: () => withEditor(formatting.lof),
    },
    {
      label: "Insert list of tables",
      icon: <Table2 size={14} />,
      disabled: !editingMarkdown,
      onSelect: () => withEditor(formatting.lot),
    },
    MENU_SEPARATOR,
    {
      label: `Split current ${unit}`,
      icon: <Scissors size={14} />,
      hint: "at its headings",
      disabled: !editingMarkdown,
      onSelect: splitActivePart,
    },
    { label: `Add ${unit}`, icon: <FilePlus size={14} />, hint: "after this one", onSelect: addPartAfterActive },
  ];
}

const MODES: { mode: EditorMode; label: string; title: string }[] = [
  { mode: "writing", label: "Writing", title: "Writing mode: math, figures and citations rendered in place" },
  { mode: "source", label: "Source", title: "Source mode: the Markdown as typed" },
];

function ModeSwitch({ disabled }: { disabled: boolean }) {
  const current = useStore((s) => s.editorMode);
  return (
    <div role="group" aria-label="Editor mode" className="flex shrink-0 items-center rounded-md bg-raised p-0.5">
      {MODES.map(({ mode, label, title }) => (
        <button
          key={mode}
          type="button"
          aria-pressed={current === mode}
          title={title}
          disabled={disabled}
          onClick={() => setEditorMode(mode)}
          className={cx(
            "h-6 rounded px-2 text-xs font-medium transition-colors cursor-default disabled:opacity-50",
            current === mode ? "bg-panel text-fg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Toolbar() {
  const dir = useStore((s) => s.dir);
  const meta = useStore((s) => s.meta);
  const theme = useStore((s) => s.theme);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const compiling = useStore((s) => s.compile.state === "running");
  const reviewMode = useStore((s) => s.reviewMode);
  const editingMarkdown = useStore((s) => isPartFile(s.activeFile));
  const chapters = unitName(meta?.template) === "chapter";
  const headingLabels: Partial<Record<Action, string>> = chapters ? { h1: "Chapter", h2: "Section" } : {};

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
      <div className="min-w-0 max-w-56 shrink px-1">
        <div className="truncate text-[13px] font-semibold text-fg">{meta?.title || "Untitled"}</div>
        <div className="truncate text-[11px] text-faint">{dir ? baseName(dir) : ""}</div>
      </div>

      <div className="mx-1 h-5 w-px shrink-0 bg-line" />
      <div className="flex min-w-0 items-center gap-0.5 overflow-hidden">
        {GROUPS.map((group, i) => (
          // Lists collapse first on narrow windows; they are one keystroke away anyway.
          <div key={i} className={i === 2 ? "hidden items-center gap-0.5 xl:flex" : "flex shrink-0 items-center gap-0.5"}>
            {i > 0 && <div className="mx-1 h-4 w-px bg-line" />}
            {group.map((b) => (
              <IconButton
                key={b.action}
                label={headingLabels[b.action] ?? b.label}
                shortcut={b.shortcut}
                disabled={!editingMarkdown}
                onClick={() => withEditor(formatting[b.action])}
              >
                {b.icon}
              </IconButton>
            ))}
          </div>
        ))}
        <div className="flex shrink-0 items-center gap-0.5">
          <div className="mx-1 h-4 w-px bg-line" />
          <IconButton label="Add comment" shortcut={`${MOD}⌥C`} disabled={!editingMarkdown} onClick={() => withEditor(addComment)}>
            <MessageSquarePlus size={15} />
          </IconButton>
        </div>
      </div>

      <div className="flex-1" />
      <ModeSwitch disabled={!editingMarkdown} />
      {meta && (
        <Menu
          className="shrink-0"
          trigger={
            <Button variant="ghost" aria-haspopup="menu">
              <TableOfContents size={14} /> Document <ChevronDown size={13} className="text-faint" />
            </Button>
          }
          items={documentMenu(meta.template, editingMarkdown)}
        />
      )}
      <Button
        variant="ghost"
        className={cx("shrink-0", reviewMode && "bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent")}
        aria-pressed={reviewMode}
        aria-label="Review"
        onClick={() => setReviewMode(!reviewMode)}
        title="Review: the preview and Typeset show comments, highlighted with their notes. Export PDF stays final."
      >
        <MessageSquareText size={14} /> <span className="hidden xl:inline">Review</span>
      </Button>
      <Button
        variant="primary"
        className="shrink-0"
        onClick={() => run(() => compileNow("full"))}
        title={`Save and typeset (${MOD}S)`}
      >
        {compiling ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />}
        Typeset
      </Button>
      <Menu
        className="shrink-0"
        trigger={
          <Button aria-haspopup="menu">
            <FileDown size={14} /> Export <ChevronDown size={13} className="text-faint" />
          </Button>
        }
        items={[
          { label: "PDF…", icon: <FileDown size={14} />, shortcut: `${MOD}${SHIFT}E`, onSelect: () => run(exportPdf) },
          { label: "Review PDF…", icon: <MessageSquareText size={14} />, hint: "with comments", onSelect: () => run(exportReviewPdf) },
          { label: "LaTeX sources (.zip)…", icon: <FileArchive size={14} />, onSelect: () => run(exportLatex) },
          { label: "Show project folder", icon: <FolderOpen size={14} />, onSelect: () => run(revealProject) },
        ]}
      />
      <IconButton
        className="shrink-0"
        label={theme === "dark" ? "Light theme" : "Dark theme"}
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      >
        {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      </IconButton>
      <IconButton className="shrink-0" label="Close project" onClick={() => run(closeProject)}>
        <LogOut size={15} />
      </IconButton>
    </header>
  );
}
