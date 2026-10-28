import { GitCompareArrows, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type ChangeStatus, type DiffSegment, type PartDiff, type VersionDiff } from "@/lib/api";
import { foldSegments, headWords, versionDate, whenLabel } from "@/lib/history";
import { closeCompare, restorePart } from "@/history";
import { useStore } from "@/store";
import { notify } from "./Toaster";
import { Button, cx } from "./ui";

/** Words of an added or deleted part shown before "Show N more words". */
const PREVIEW_WORDS = 60;

const STATUS_LABELS: Record<ChangeStatus, string> = { added: "Added", deleted: "Deleted", modified: "Edited", renamed: "Renamed" };

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function Segment({ segment }: { segment: DiffSegment }) {
  if (segment.kind === "insert") {
    return <ins className="rounded-sm bg-ok/15 text-fg decoration-ok/60 underline-offset-2">{segment.text}</ins>;
  }
  if (segment.kind === "delete") {
    return <del className="rounded-sm bg-danger/10 text-muted decoration-danger/70">{segment.text}</del>;
  }
  return <>{segment.text}</>;
}

function FoldButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-0.5 inline-flex cursor-default items-center rounded bg-raised px-1.5 align-baseline font-sans text-[11px] text-muted hover:text-fg"
    >
      {children}
    </button>
  );
}

/** Edited parts fold their long unchanged runs; added and deleted ones show their first words. */
function PartText({ part }: { part: PartDiff }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [all, setAll] = useState(false);
  const shown = useMemo(() => foldSegments(part.segments), [part.segments]);
  const whole = part.status === "added" || part.status === "deleted";

  if (whole) {
    const kind = part.status === "added" ? "insert" : "delete";
    const text = part.segments.map((s) => s.text).join("");
    const { head, rest } = all ? { head: text, rest: 0 } : headWords(text, PREVIEW_WORDS);
    return (
      <>
        <Segment segment={{ kind, text: head }} />
        {rest > 0 && <FoldButton onClick={() => setAll(true)}>Show {rest.toLocaleString()} more words</FoldButton>}
      </>
    );
  }
  return (
    <>
      {shown.map((s, i) =>
        s.kind !== "fold" ? (
          <Segment key={i} segment={s} />
        ) : expanded.has(i) ? (
          <span key={i}>{s.text}</span>
        ) : (
          <FoldButton key={i} onClick={() => setExpanded(new Set(expanded).add(i))}>
            Show {s.words.toLocaleString()} unchanged {s.words === 1 ? "word" : "words"}
          </FoldButton>
        ),
      )}
    </>
  );
}

function RestorePart({ part, target, when, onRestored }: { part: PartDiff; target: { id: string; file: string }; when: string; onRestored: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const exists = useStore((s) => s.parts.some((p) => p.file === target.file));
  if (!confirm) {
    return (
      <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setConfirm(true)} title={`Bring this part back as it was at ${when}`}>
        <RotateCcw size={13} /> Restore this part
      </Button>
    );
  }
  return (
    <div role="alertdialog" aria-label={`Restore ${part.title}`} className="flex shrink-0 items-center gap-1.5">
      <span className="text-[11px] text-muted">{exists ? "Replace its current text?" : "Add it back to the paper?"}</span>
      <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
        Cancel
      </Button>
      <Button
        size="sm"
        variant="primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          restorePart(target.id, target.file, part.title)
            .then(onRestored)
            .catch((e) => notify(message(e), "error"))
            .finally(() => {
              setBusy(false);
              setConfirm(false);
            });
        }}
      >
        Restore
      </Button>
    </div>
  );
}

function PartCard({ part, compare, when, onRestored }: { part: PartDiff; compare: { from: string; to: string | null }; when: string; onRestored: () => void }) {
  // The snapshot of interest: the old one against the current text, else the newer one.
  const target = compare.to === null ? { id: compare.from, file: part.oldFile ?? part.file } : { id: compare.to, file: part.file };
  const restorable = compare.to === null ? part.status !== "added" : part.status !== "deleted";
  return (
    <section aria-label={part.title} className="overflow-hidden rounded-lg border border-line bg-panel">
      <header className="flex min-h-10 items-center gap-2 border-b border-line bg-raised/40 px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate text-[13px] font-semibold text-fg">{part.title}</h3>
            <span
              className={cx(
                "shrink-0 rounded px-1.5 py-px text-[10px] font-medium",
                part.status === "added" ? "bg-ok/15 text-ok" : part.status === "deleted" ? "bg-danger/10 text-danger" : "bg-raised text-muted",
              )}
            >
              {STATUS_LABELS[part.status]}
            </span>
          </div>
          <div className="truncate font-mono text-[10px] text-faint">
            {part.oldFile && part.oldFile !== part.file ? `${part.oldFile} → ${part.file}` : part.file}
          </div>
        </div>
        {restorable && <RestorePart part={part} target={target} when={when} onRestored={onRestored} />}
      </header>
      <div className="whitespace-pre-wrap break-words px-4 py-3 text-[13px] leading-relaxed text-fg">
        <PartText part={part} />
      </div>
    </section>
  );
}

function ListCard({ title, items }: { title: string; items: string[] }) {
  return (
    <section aria-label={title} className="rounded-lg border border-line bg-panel px-3 py-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <ul className="mt-1 space-y-0.5">
        {items.map((item, i) => (
          <li key={i} className="text-[12px] text-fg">
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

const BIB_VERBS: Record<ChangeStatus, string> = { added: "Added", deleted: "Removed", modified: "Edited", renamed: "Renamed" };

function bibLines(bib: VersionDiff["bib"]): string[] {
  return (["added", "modified", "deleted", "renamed"] as const).flatMap((status) => {
    const keys = bib.filter((b) => b.status === status).map((b) => b.key);
    return keys.length ? [`${BIB_VERBS[status]}: ${keys.join(", ")}`] : [];
  });
}

function fileLines(files: VersionDiff["files"]): string[] {
  return files.map((f) =>
    f.status === "renamed" && f.oldPath ? `Renamed ${f.oldPath} to ${f.path}` : `${BIB_VERBS[f.status]} ${f.path}`,
  );
}

export function HistoryDiffView() {
  const compare = useStore((s) => s.compare);
  const dir = useStore((s) => s.dir);
  const versions = useStore((s) => s.versions);
  const [result, setResult] = useState<{ diff: VersionDiff | null; error: string | null; key: string } | null>(null);
  const [reload, setReload] = useState(0);
  const key = compare ? `${compare.from}:${compare.to}:${reload}` : "";

  useEffect(() => {
    if (!dir || !compare) return;
    let live = true;
    api
      .historyDiff(dir, compare.from, compare.to)
      .then((diff) => live && setResult({ diff, error: null, key }))
      .catch((e) => live && setResult({ diff: null, error: message(e), key }));
    return () => {
      live = false;
    };
  }, [dir, compare, key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && closeCompare();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!compare) return null;
  const whenOf = (id: string) => {
    const v = versions.find((x) => x.id === id);
    return v ? whenLabel(versionDate(v)) : id.slice(0, 7);
  };
  const describe = (id: string) => {
    const label = versions.find((x) => x.id === id)?.label;
    return label ? `${whenOf(id)} · ${label}` : whenOf(id);
  };
  const when = whenOf(compare.to ?? compare.from);
  const loading = result?.key !== key;
  const diff = loading ? null : result?.diff;
  const empty = diff && diff.parts.length + diff.meta.length + diff.bib.length + diff.files.length === 0;

  return (
    <div role="region" aria-label="Compare versions" className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2.5">
        <GitCompareArrows size={14} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          From <span className="font-medium text-fg">{describe(compare.from)}</span> to{" "}
          <span className="font-medium text-fg">{compare.to ? describe(compare.to) : "the current text"}</span>
        </span>
        <Button size="sm" variant="ghost" className="shrink-0" onClick={closeCompare} title="Back to the editor (Esc)">
          <X size={13} /> Close
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto bg-bg p-3">
        {loading && (
          <p className="flex items-center gap-2 p-2 text-[12px] text-muted">
            <LoaderCircle size={13} className="animate-spin" /> Comparing…
          </p>
        )}
        {!loading && result?.error && (
          <p role="alert" className="select-text p-2 text-[12px] text-danger">
            Could not compare these versions: {result.error}
          </p>
        )}
        {empty && <p className="p-2 text-[12px] text-muted">No differences.</p>}
        {diff && (
          <>
            {diff.parts.map((part) => (
              <PartCard
                key={`${part.oldFile ?? ""}:${part.file}`}
                part={part}
                compare={compare}
                when={when}
                onRestored={() => setReload((n) => n + 1)}
              />
            ))}
            {diff.meta.length > 0 && <ListCard title="Paper settings" items={diff.meta.map((m) => m.description)} />}
            {diff.bib.length > 0 && <ListCard title="References" items={bibLines(diff.bib)} />}
            {diff.files.length > 0 && <ListCard title="Other files" items={fileLines(diff.files)} />}
          </>
        )}
      </div>
    </div>
  );
}
