import { CircleAlert, CircleCheck, Cloud, LoaderCircle, TriangleAlert } from "lucide-react";
import { useDeferredValue, useMemo } from "react";
import { wordCount } from "@/lib/outline";
import { LANGUAGES, templateInfo } from "@/lib/templates";
import { store, useStore } from "@/store";

export function StatusBar() {
  const compile = useStore((s) => s.compile);
  const diagnostics = useStore((s) => s.diagnostics);
  const cursor = useStore((s) => s.cursor);
  const meta = useStore((s) => s.meta);
  const saveState = useStore((s) => s.saveState);
  const saveError = useStore((s) => s.saveError);
  const body = useDeferredValue(useStore((s) => s.body));
  const words = useMemo(() => wordCount(body), [body]);
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-panel px-3 text-[11px] text-muted">
      <span className="flex items-center gap-1.5">
        {compile.state === "running" ? (
          <>
            <LoaderCircle size={12} className="animate-spin text-accent" /> Typesetting…
          </>
        ) : compile.state === "error" ? (
          <>
            <CircleAlert size={12} className="text-danger" /> Compile failed
          </>
        ) : compile.state === "ok" ? (
          <>
            <CircleCheck size={12} className="text-ok" /> Typeset in {((compile.ms ?? 0) / 1000).toFixed(1)} s
            {compile.passes > 1 && ` · ${compile.passes} passes`}
          </>
        ) : (
          "Ready"
        )}
      </span>
      {compile.usedNetwork && (
        <span className="flex items-center gap-1" title="A package was missing from the offline cache and was downloaded once">
          <Cloud size={12} /> fetched packages
        </span>
      )}
      <button
        className="flex items-center gap-2 rounded px-1 hover:bg-raised hover:text-fg cursor-default"
        onClick={() => store.set((s) => ({ problemsOpen: !s.problemsOpen }))}
        title="Toggle problems"
      >
        <span className="flex items-center gap-1">
          <CircleAlert size={12} className={errors ? "text-danger" : ""} /> {errors}
        </span>
        <span className="flex items-center gap-1">
          <TriangleAlert size={12} className={warnings ? "text-warn" : ""} /> {warnings}
        </span>
      </button>
      <span className={saveState === "error" ? "text-danger" : ""} title={saveError ?? undefined}>
        {saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : "Saving…"}
      </span>
      <div className="flex-1" />
      <span>{words.toLocaleString()} words</span>
      <span className="tabular-nums">
        Ln {cursor.line}, Col {cursor.col}
      </span>
      {meta && <span>{templateInfo(meta.template).label}</span>}
      {meta && <span>{LANGUAGES.find((l) => l.id === meta.language)?.label ?? meta.language}</span>}
    </footer>
  );
}
