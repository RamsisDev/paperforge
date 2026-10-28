import { CircleAlert, TriangleAlert, X } from "lucide-react";
import { useMemo } from "react";
import { baseName } from "@/lib/api";
import { locate } from "@/lib/diagnostics";
import { jumpTo, store, useStore } from "@/store";
import { IconButton, cx } from "./ui";

export function ProblemsPanel() {
  const diagnostics = useStore((s) => s.diagnostics);
  const located = useMemo(() => {
    const items = locate(diagnostics, store.get().parts);
    return items.sort((a, b) => (a.diagnostic.severity === b.diagnostic.severity ? 0 : a.diagnostic.severity === "error" ? -1 : 1));
  }, [diagnostics]);

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-line bg-panel">
      <div className="flex h-8 shrink-0 items-center gap-2 px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Problems</span>
        <span className="text-[11px] text-faint">{located.length === 0 ? "None" : located.length}</span>
        <div className="flex-1" />
        <IconButton label="Close problems" onClick={() => store.set({ problemsOpen: false })}>
          <X size={14} />
        </IconButton>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto pb-1">
        {located.length === 0 && <li className="px-3 py-2 text-xs text-muted">The last compile reported nothing.</li>}
        {located.map(({ diagnostic: d, file, line }, i) => (
          <li key={i}>
            <button
              disabled={file === null}
              onClick={() => file && line !== null && jumpTo(file, line)}
              className="flex w-full items-start gap-2 px-3 py-1 text-left hover:bg-raised disabled:hover:bg-transparent cursor-default"
            >
              {d.severity === "error" ? (
                <CircleAlert size={14} className="mt-0.5 shrink-0 text-danger" />
              ) : (
                <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warn" />
              )}
              <span className={cx("min-w-0 flex-1 break-words text-[12px]", d.severity === "error" ? "text-fg" : "text-muted")}>
                {d.message}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-faint" title={file ?? undefined}>
                {d.stage}
                {file && line !== null ? ` · ${baseName(file)}:${line + 1}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
