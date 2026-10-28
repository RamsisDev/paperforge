import { BookmarkPlus, ChevronRight, Ellipsis, Eye, GitCompareArrows, History, RotateCcw, Tag, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { HistoryStatus, VersionInfo } from "@/lib/api";
import { clockLabel, timeline, versionDate, whenLabel, type TimelineEntry } from "@/lib/history";
import {
  compareWithCurrent,
  enableHistory,
  labelVersion,
  loadOlderVersions,
  refreshHistory,
  restoreVersion,
  viewChanges,
} from "@/history";
import { store, useStore } from "@/store";
import { notify } from "../Toaster";
import { Button, IconButton, Input, MENU_SEPARATOR, MOD, Menu, SHIFT, cx, type MenuItem } from "../ui";

function run(task: () => Promise<unknown>) {
  task().catch((e) => notify(e instanceof Error ? e.message : String(e), "error"));
}

function EnableBanner({ status }: { status: HistoryStatus | null }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="p-3">
      <section aria-label="Version history is off" className="space-y-2.5 rounded-lg border border-line bg-raised/50 p-3">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
          <History size={14} className="text-muted" /> Version history
        </h3>
        <p className="text-[12px] leading-snug text-muted">
          Keep earlier states of this paper: a snapshot every few minutes while you write, a version when you close or export, and
          named milestones such as “Sent to reviewer”. Compare any two, and restore the whole paper or a single part.
        </p>
        {status?.mode === "parentRepo" ? (
          <p className="text-[12px] leading-snug text-muted">
            This project folder is inside another git repository, which keeps its versions. Version history is not available for
            it yet.
          </p>
        ) : (
          <>
            <Button
              variant="primary"
              className="w-full"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                run(() => enableHistory().finally(() => setBusy(false)));
              }}
            >
              Enable version history
            </Button>
            <p className="text-[11px] leading-snug text-faint">
              Stored in the project folder as a git repository, so it travels with the paper.
            </p>
          </>
        )}
      </section>
    </div>
  );
}

type Prompt = "restore" | "name" | null;

function NameForm({ version, onDone }: { version: VersionInfo; onDone: () => void }) {
  const [name, setName] = useState(version.label ?? "");
  return (
    <form
      className="mt-1 flex gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => labelVersion(version, name.trim() || null));
        onDone();
      }}
    >
      <Input
        autoFocus
        className="h-7"
        aria-label="Version name"
        placeholder="e.g. Sent to reviewer"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onDone()}
      />
      <Button size="sm" variant="primary" type="submit">
        Save
      </Button>
      <Button size="sm" variant="ghost" type="button" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}

function SnapshotRow({ version, oldest, nested }: { version: VersionInfo; oldest: boolean; nested?: boolean }) {
  const [prompt, setPrompt] = useState<Prompt>(null);
  const shown = useStore((s) => s.compare !== null && (s.compare.to === version.id || (s.compare.to === null && s.compare.from === version.id)));
  const isVersion = version.kind === "version";
  const when = whenLabel(versionDate(version));
  const items: (MenuItem | typeof MENU_SEPARATOR)[] = [
    {
      label: "View changes",
      icon: <Eye size={14} />,
      hint: oldest ? "first version" : undefined,
      disabled: oldest,
      onSelect: () => run(() => viewChanges(version)),
    },
    { label: "Compare with current", icon: <GitCompareArrows size={14} />, onSelect: () => compareWithCurrent(version) },
    MENU_SEPARATOR,
    { label: "Restore this version…", icon: <RotateCcw size={14} />, onSelect: () => setPrompt("restore") },
  ];
  if (isVersion) {
    items.push({ label: version.label ? "Rename…" : "Name…", icon: <Tag size={14} />, onSelect: () => setPrompt("name") });
    if (version.label) items.push({ label: "Remove name", icon: <X size={14} />, onSelect: () => run(() => labelVersion(version, null)) });
  }

  return (
    <li aria-label={`${isVersion ? "Version" : "Autosave"} ${when}`} className={cx("group relative", nested ? "pl-9" : "pl-5")}>
      <span
        aria-hidden
        className={cx(
          "absolute left-[3px] top-[9px] h-[9px] w-[9px] rounded-full",
          isVersion ? "bg-accent ring-2 ring-panel" : "border border-faint bg-panel",
          nested && "left-[4px] h-[7px] w-[7px]",
        )}
      />
      <div className={cx("flex items-start gap-0.5 rounded-md pr-0.5", shown ? "bg-accent-soft/70" : "hover:bg-raised")}>
        <button
          type="button"
          className="min-w-0 flex-1 cursor-default px-1.5 py-1 text-left"
          title={oldest ? version.summary : `${version.summary}. Click to view the changes`}
          onClick={() => (oldest ? compareWithCurrent(version) : run(() => viewChanges(version)))}
        >
          <div className="flex items-baseline gap-2">
            <span className={cx("min-w-0 flex-1 truncate text-[12px]", isVersion ? "font-semibold text-fg" : "text-muted")}>
              {version.summary}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-faint">{clockLabel(versionDate(version))}</span>
          </div>
          {(version.label || version.note) && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              {version.label && (
                <span className="inline-flex max-w-full items-center gap-1 rounded bg-accent-soft px-1.5 py-px text-[11px] font-medium text-accent">
                  <Tag size={10} className="shrink-0" />
                  <span className="truncate">{version.label}</span>
                </span>
              )}
              {version.note && <span className="whitespace-pre-wrap break-words text-[11px] text-faint">{version.note}</span>}
            </div>
          )}
        </button>
        <Menu
          className="mt-0.5 shrink-0"
          trigger={
            <IconButton
              label={`Actions for ${when}`}
              className="h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
              aria-haspopup="menu"
            >
              <Ellipsis size={14} />
            </IconButton>
          }
          items={items}
        />
      </div>
      {prompt === "restore" && (
        <div
          role="alertdialog"
          aria-label="Restore version"
          ref={(el) => el?.scrollIntoView({ behavior: "smooth", block: "nearest" })}
          className="mt-1 space-y-2 rounded-lg border border-line bg-raised/50 p-2.5"
        >
          <p className="text-[12px] leading-snug text-muted">
            Restore the whole paper to how it was at {when}? Your current text is kept as an autosave first, so you can come back to
            it.
          </p>
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setPrompt(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setPrompt(null);
                run(() => restoreVersion(version));
              }}
            >
              Restore
            </Button>
          </div>
        </div>
      )}
      {prompt === "name" && <NameForm version={version} onDone={() => setPrompt(null)} />}
    </li>
  );
}

function AutosaveRun({ versions, oldestId }: { versions: VersionInfo[]; oldestId: string | null }) {
  const [open, setOpen] = useState(false);
  const newest = clockLabel(versionDate(versions[0]));
  const oldest = clockLabel(versionDate(versions[versions.length - 1]));
  return (
    <li className="relative pl-5">
      <span aria-hidden className="absolute left-[4px] top-[9px] h-[7px] w-[7px] rounded-full border border-dashed border-faint bg-panel" />
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-default items-center gap-1 rounded-md px-1.5 py-1 text-left text-[12px] text-muted hover:bg-raised hover:text-fg"
      >
        <ChevronRight size={12} className={cx("shrink-0 transition-transform", open && "rotate-90")} />
        <span className="flex-1">{versions.length} autosaves</span>
        <span className="shrink-0 text-[11px] tabular-nums text-faint">
          {oldest}–{newest}
        </span>
      </button>
      {open && (
        <ol aria-label={`${versions.length} autosaves`} className="-ml-5">
          {versions.map((v) => (
            <SnapshotRow key={v.id} version={v} oldest={v.id === oldestId} nested />
          ))}
        </ol>
      )}
    </li>
  );
}

function Entry({ entry, oldestId }: { entry: TimelineEntry; oldestId: string | null }) {
  return entry.kind === "autosaves" ? (
    <AutosaveRun versions={entry.versions} oldestId={oldestId} />
  ) : (
    <SnapshotRow version={entry.version} oldest={entry.version.id === oldestId} />
  );
}

function CurrentRow({ last }: { last: VersionInfo }) {
  const shown = useStore((s) => s.compare?.to === null && s.compare.from === last.id);
  return (
    <div className="relative pl-5">
      <span aria-hidden className="absolute left-[3px] top-[9px] h-[9px] w-[9px] rounded-full border-2 border-accent bg-panel" />
      <button
        type="button"
        onClick={() => compareWithCurrent(last)}
        className={cx(
          "flex w-full cursor-default items-baseline gap-2 rounded-md px-1.5 py-1 text-left",
          shown ? "bg-accent-soft/70" : "hover:bg-raised",
        )}
        title="Compare the current text with the last version"
      >
        <span className="flex-1 text-[12px] font-medium text-fg">Current text</span>
        <span className="shrink-0 text-[11px] text-faint">vs. last version</span>
      </button>
    </div>
  );
}

export function HistoryPanel() {
  const status = useStore((s) => s.historyStatus);
  const versions = useStore((s) => s.versions);
  const more = useStore((s) => s.historyMore);
  const [loaded, setLoaded] = useState(status !== null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const days = useMemo(() => timeline(versions), [versions]);

  useEffect(() => {
    void refreshHistory().finally(() => setLoaded(true));
  }, []);

  if (!status?.enabled) return loaded ? <EnableBanner status={status} /> : null;
  const oldestId = more ? null : (versions.at(-1)?.id ?? null);

  return (
    <div className="space-y-3 p-3">
      <Button className="w-full" onClick={() => store.set({ versionDialog: true })} title={`${MOD}${SHIFT}S`}>
        <BookmarkPlus size={14} /> Save version…
      </Button>
      {status.lastVersion && <CurrentRow last={status.lastVersion} />}
      <div role="group" aria-label="Version history" className="relative space-y-3">
        <span aria-hidden className="absolute bottom-2 left-[7px] top-2 w-px bg-line" />
        {days.map((day) => (
          <section key={day.label} aria-label={day.label}>
            <h3 className="relative bg-panel py-0.5 pl-5 text-[11px] font-semibold uppercase tracking-wide text-faint">{day.label}</h3>
            <ol className="space-y-px">
              {day.entries.map((entry) => (
                <Entry key={entry.kind === "autosaves" ? entry.versions[0].id : entry.version.id} entry={entry} oldestId={oldestId} />
              ))}
            </ol>
          </section>
        ))}
      </div>
      {versions.length === 0 && <p className="text-[11px] text-faint">No versions yet.</p>}
      {more && (
        <Button
          size="sm"
          variant="ghost"
          className="w-full"
          disabled={loadingOlder}
          onClick={() => {
            setLoadingOlder(true);
            run(() => loadOlderVersions().finally(() => setLoadingOlder(false)));
          }}
        >
          Load older
        </Button>
      )}
      <p className="text-[11px] leading-snug text-faint">
        Autosaved a couple of minutes after you stop typing. Versions are kept when you close the project, export, or save one
        yourself; name a version to find it again.
      </p>
    </div>
  );
}
