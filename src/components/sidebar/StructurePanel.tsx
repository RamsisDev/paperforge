import { ArrowDown, ArrowUp, ChevronRight, Lightbulb, Merge, Plus, Scissors, Settings2, Trash } from "lucide-react";
import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { insertInline } from "@/editor/commands";
import { withEditor } from "@/editor/bridge";
import { baseName, type Part, type TemplateId, type TocEntry } from "@/lib/api";
import { labels, withEffectiveLevels, type EffectiveHeading } from "@/lib/outline";
import { allText, bestLineInParts, findHeading, partInfo, partTitle, splitHint, splitLevel } from "@/lib/parts";
import { unitName, usesChapters } from "@/lib/templates";
import { arabicPage, tocIndents, tocLists } from "@/lib/toc";
import { createPart, deletePart, mergeWithNext, movePart, splitPart } from "@/session";
import { askNewPart, jumpTo, openFile, revealPage, showContentsSettings, store, useStore } from "@/store";
import { notify } from "../Toaster";
import { Button, IconButton, Input, cx } from "../ui";

function run(task: () => Promise<unknown>) {
  task().catch((e) => notify(String(e), "error"));
}

function Heading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-1 pb-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">{children}</h3>
      {action}
    </div>
  );
}

// Contents --------------------------------------------------------------------------------------

function openEntry(entry: TocEntry) {
  const page = arabicPage(entry.page);
  if (page !== null) revealPage(page);
  const parts = store.get().parts;
  const target = entry.list === "toc" ? findHeading(parts, entry.title) : bestLineInParts(entry.title, parts);
  if (target) jumpTo(target.file, target.line);
}

function TocList({ entries, label }: { entries: TocEntry[]; label: string }) {
  const indents = useMemo(() => tocIndents(entries), [entries]);
  return (
    <ul aria-label={label}>
      {entries.map((e, i) => {
        const top = indents[i] === 0 && e.list === "toc";
        return (
          <li key={i} className={cx(top && i > 0 && "mt-1")}>
            <button
              onClick={() => openEntry(e)}
              title={`${e.number ? `${e.number} ` : ""}${e.title} — page ${e.page}`}
              className="flex w-full items-baseline gap-1.5 rounded py-[3px] pr-1 text-left text-[12px] hover:bg-raised cursor-default"
              style={{ paddingLeft: 4 + indents[i] * 14 }}
            >
              {e.number && <span className="shrink-0 tabular-nums text-muted">{e.number}</span>}
              <span className={cx("min-w-0 truncate", top ? "font-medium text-fg" : "text-fg")}>{e.title}</span>
              <span aria-hidden className="min-w-3 flex-1 -translate-y-[3px] border-b border-dotted border-faint" />
              <span className={cx("shrink-0 tabular-nums", top ? "text-fg" : "text-muted")}>{e.page}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Collapsible({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="pt-2">
      <button
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] font-medium text-muted hover:text-fg cursor-default"
      >
        <ChevronRight size={12} className={cx("transition-transform", open && "rotate-90")} />
        {title} <span className="font-normal text-faint">{count}</span>
      </button>
      {open && children}
    </div>
  );
}

function ContentsView() {
  const toc = useStore((s) => s.toc);
  const lists = useMemo(() => tocLists(toc), [toc]);
  const empty = lists.toc.length + lists.lof.length + lists.lot.length === 0;
  return (
    <section>
      <Heading
        action={
          <IconButton label="Contents & lists settings" className="h-6 w-6" onClick={showContentsSettings}>
            <Settings2 size={13} />
          </IconButton>
        }
      >
        Contents
      </Heading>
      {empty ? (
        <p className="px-1 text-xs text-muted">Typeset to generate the contents.</p>
      ) : (
        <div className="rounded-lg border border-line px-1.5 py-1.5">
          {lists.toc.length > 0 && <TocList entries={lists.toc} label="Table of contents" />}
          {lists.lof.length > 0 && (
            <Collapsible title="Figures" count={lists.lof.length}>
              <TocList entries={lists.lof} label="List of figures" />
            </Collapsible>
          )}
          {lists.lot.length > 0 && (
            <Collapsible title="Tables" count={lists.lot.length}>
              <TocList entries={lists.lot} label="List of tables" />
            </Collapsible>
          )}
        </div>
      )}
    </section>
  );
}

// Parts -----------------------------------------------------------------------------------------

function NewPartInput({ index, unit }: { index: number; unit: string }) {
  const [title, setTitle] = useState("");
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const cancel = () => store.set({ addingPart: null });
  return (
    <li>
      <form
        ref={ref}
        className="flex gap-1.5 rounded-lg border border-dashed border-accent p-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) run(() => createPart(index, title.trim()));
        }}
      >
        <Input
          autoFocus
          aria-label={`Title of the new ${unit}`}
          value={title}
          placeholder={`New ${unit} title`}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && cancel()}
        />
        <Button size="sm" variant="primary" type="submit" disabled={!title.trim()}>
          Add
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={cancel}>
          Cancel
        </Button>
      </form>
    </li>
  );
}

type Prompt = "delete" | "split" | null;

function PartCard({
  part,
  index,
  count,
  active,
  unit,
  template,
}: {
  part: Part;
  index: number;
  count: number;
  active: boolean;
  unit: string;
  template: TemplateId | undefined;
}) {
  const info = partInfo(part);
  const title = partTitle(part);
  const level = splitLevel(part);
  const hint = splitHint(part, template);
  const chapters = usesChapters(template);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const hs = useMemo(() => withEffectiveLevels(info.headings, chapters), [info, chapters]);
  const titled = hs[0]?.text === title;
  const subheadings = titled ? hs.slice(1) : hs;
  const baseLevel = Math.min(...subheadings.map((h) => h.effectiveLevel));
  const canSplit = { 1: info.levels[1] >= 2, 2: info.levels[2] >= 2 };
  const demotedTitle = (h: EffectiveHeading) =>
    titled && h.effectiveLevel !== h.level ? `${h.text} — written as ${"#".repeat(h.level)}, a subtopic of “${title}”` : h.text;

  function split() {
    if (canSplit[1] && canSplit[2]) setPrompt(prompt === "split" ? null : "split");
    else if (level) run(() => splitPart(part.file, level));
  }

  const action = "h-6 w-6";
  return (
    <li
      className={cx(
        "group relative rounded-lg border transition-colors",
        active ? "border-accent bg-accent-soft/60" : "border-line bg-panel hover:border-faint",
      )}
    >
      <button
        className="block w-full px-2.5 pb-1.5 pt-2 text-left cursor-default"
        aria-current={active ? "true" : undefined}
        onClick={() => openFile(part.file)}
        title={`Open ${part.file}`}
      >
        <div className="flex items-baseline gap-1.5">
          <span className="shrink-0 text-[11px] tabular-nums text-faint">{index + 1}</span>
          <span className="truncate text-[13px] font-medium text-fg">{title}</span>
        </div>
        <div className="truncate pl-3.5 text-[11px] text-faint">
          <span className="font-mono">{baseName(part.file)}</span> · {info.words.toLocaleString()}{" "}
          {info.words === 1 ? "word" : "words"}
        </div>
      </button>

      {subheadings.length > 0 && (
        <ul aria-label={`Headings of ${title}`} className={cx(chapters && titled ? "mb-2 ml-6 mr-2 border-l border-line" : "pb-1.5")}>
          {subheadings.map((h) => (
            <li key={`${h.line}-${h.text}`}>
              <button
                onClick={() => jumpTo(part.file, h.line)}
                className="block w-full truncate py-0.5 pr-2 text-left text-[12px] text-muted hover:bg-raised hover:text-fg cursor-default"
                style={{ paddingLeft: (chapters && titled ? 8 : 24) + (h.effectiveLevel - baseLevel) * 12 }}
                title={demotedTitle(h)}
              >
                {h.text}
              </button>
            </li>
          ))}
        </ul>
      )}

      {hint && prompt === null && (
        <div className="mx-2 mb-2 flex items-center gap-2 rounded-md bg-raised px-2 py-1.5 text-[11px] text-muted">
          <Lightbulb size={12} className="shrink-0 text-warn" />
          <span className="flex-1">
            {hint.demoted > 0 ? (
              <>
                {hint.demoted} subtopic{hint.demoted === 1 ? " uses" : "s use"} <code className="font-mono">#</code> — make{" "}
                {hint.demoted === 1 ? "it a chapter" : "them chapters"}?
              </>
            ) : (
              <>
                Long {unit} — split it {hint.level === 1 ? `into ${unit}s` : "at its ## headings"}?
              </>
            )}
          </span>
          <button
            className="shrink-0 font-medium text-accent hover:underline cursor-default"
            onClick={() => run(() => splitPart(part.file, hint.level))}
          >
            Split
          </button>
        </div>
      )}

      {prompt === "split" && (
        <div className="mx-2 mb-2 space-y-1.5 rounded-md bg-raised px-2 py-1.5 text-[11px] text-muted">
          <p>Split “{title}” into one file per heading:</p>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => run(() => splitPart(part.file, 1))}>
              At # ({info.levels[1]})
            </Button>
            <Button size="sm" onClick={() => run(() => splitPart(part.file, 2))}>
              At ## ({info.levels[2]})
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPrompt(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {prompt === "delete" && (
        <div className="mx-2 mb-2 space-y-1.5 rounded-md bg-raised px-2 py-1.5 text-[11px] text-muted">
          <p>
            Delete “{title}”? Its file and its {info.words.toLocaleString()} words are removed from the project.
          </p>
          <div className="flex gap-1.5">
            <Button size="sm" className="bg-danger text-white hover:opacity-90" onClick={() => run(() => deletePart(part.file))}>
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPrompt(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div
        className={cx(
          "absolute right-1 top-1 flex gap-px rounded-md bg-panel p-px shadow-sm ring-1 ring-line",
          "opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
        )}
      >
        <IconButton className={action} label="Move up" disabled={index === 0} onClick={() => run(() => movePart(part.file, -1))}>
          <ArrowUp size={13} />
        </IconButton>
        <IconButton
          className={action}
          label="Move down"
          disabled={index === count - 1}
          onClick={() => run(() => movePart(part.file, 1))}
        >
          <ArrowDown size={13} />
        </IconButton>
        <IconButton className={action} label={`Add ${unit} after`} onClick={() => askNewPart(index + 1)}>
          <Plus size={13} />
        </IconButton>
        <IconButton className={action} label={`Split into ${unit}s at its headings`} disabled={!level} onClick={split}>
          <Scissors size={13} />
        </IconButton>
        <IconButton
          className={action}
          label="Merge with next"
          disabled={index === count - 1}
          onClick={() => run(() => mergeWithNext(part.file))}
        >
          <Merge size={13} />
        </IconButton>
        <IconButton
          className={cx(action, "hover:text-danger")}
          label={`Delete ${unit}`}
          disabled={count === 1}
          onClick={() => setPrompt(prompt === "delete" ? null : "delete")}
        >
          <Trash size={13} />
        </IconButton>
      </div>
    </li>
  );
}

// Labels ----------------------------------------------------------------------------------------

const KIND_LABELS = { fig: "Figures", tbl: "Tables", eq: "Equations", sec: "Sections" } as const;

function LabelChips({ parts }: { parts: Part[] }) {
  const refs = useMemo(() => labels(allText(parts)), [parts]);
  return (Object.keys(KIND_LABELS) as (keyof typeof KIND_LABELS)[]).map((kind) =>
    refs[kind].length === 0 ? null : (
      <section key={kind}>
        <Heading>
          {KIND_LABELS[kind]} <span className="font-normal normal-case text-faint">· click to reference</span>
        </Heading>
        <div className="flex flex-wrap gap-1 px-1">
          {refs[kind].map((id) => (
            <button
              key={id}
              onClick={() => withEditor((v) => insertInline(v, `@${id}`))}
              className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted hover:border-accent hover:text-fg cursor-default"
            >
              @{id}
            </button>
          ))}
        </div>
      </section>
    ),
  );
}

export function StructurePanel() {
  const parts = useDeferredValue(useStore((s) => s.parts));
  const activeFile = useStore((s) => s.activeFile);
  const template = useStore((s) => s.meta?.template);
  const adding = useStore((s) => s.addingPart);
  const unit = unitName(template);

  return (
    <div className="space-y-5 p-3">
      <ContentsView />

      <section>
        <Heading>
          {unit === "chapter" ? "Chapters" : "Sections"} <span className="font-normal normal-case text-faint">· {parts.length} files</span>
        </Heading>
        <ol className="space-y-1.5">
          {parts.map((part, i) => (
            <Fragment key={part.file}>
              {adding === i && <NewPartInput index={i} unit={unit} />}
              <PartCard part={part} index={i} count={parts.length} active={part.file === activeFile} unit={unit} template={template} />
            </Fragment>
          ))}
          {adding !== null && adding >= parts.length && <NewPartInput index={parts.length} unit={unit} />}
        </ol>
        <Button size="sm" variant="ghost" className="mt-1.5 w-full" onClick={() => askNewPart(parts.length)}>
          <Plus size={14} /> Add {unit}
        </Button>
      </section>

      <LabelChips parts={parts} />
    </div>
  );
}
