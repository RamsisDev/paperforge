import { CircleAlert, CircleCheck, Cloud, LoaderCircle, SpellCheck, TriangleAlert } from "lucide-react";
import { useDeferredValue, useMemo, useSyncExternalStore } from "react";
import { dictionaryFor, onSpellSettings, setSpellCheck, spellCheckEnabled } from "@/editor/spell";
import { partInfo, totalWords } from "@/lib/parts";
import { LANGUAGES, templateInfo, unitName } from "@/lib/templates";
import { openGallery, store, useStore } from "@/store";

function SpellToggle({ language, label }: { language: string; label: string }) {
  const enabled = useSyncExternalStore(onSpellSettings, spellCheckEnabled);
  const supported = dictionaryFor(language) !== null;
  const title = !enabled
    ? "Spell check is off. Click to turn it on"
    : supported
      ? `Checking spelling in ${label}. Click to turn it off`
      : `No spelling dictionary for ${label} yet. Click to turn spell check off`;
  return (
    <button
      className={`flex items-center rounded px-1 hover:bg-raised hover:text-fg cursor-default ${enabled && supported ? "" : "text-faint"}`}
      title={title}
      aria-label="Spell check"
      aria-pressed={enabled}
      onClick={() => setSpellCheck(!enabled)}
    >
      <SpellCheck size={12} className={enabled ? "" : "opacity-50"} />
    </button>
  );
}

export function StatusBar() {
  const compile = useStore((s) => s.compile);
  const diagnostics = useStore((s) => s.diagnostics);
  const cursor = useStore((s) => s.cursor);
  const meta = useStore((s) => s.meta);
  const saveState = useStore((s) => s.saveState);
  const saveError = useStore((s) => s.saveError);
  const parts = useDeferredValue(useStore((s) => s.parts));
  const activeFile = useStore((s) => s.activeFile);
  const words = useMemo(() => totalWords(parts), [parts]);
  const active = parts.find((p) => p.file === activeFile);
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 overflow-hidden whitespace-nowrap border-t border-line bg-panel px-3 text-[11px] text-muted">
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
      <span title="Words in the whole document, and in the file being edited">
        {words.toLocaleString()} words
        {active && parts.length > 1 && (
          <span className="text-faint">
            {" "}
            · {partInfo(active).words.toLocaleString()} in this {unitName(meta?.template)}
          </span>
        )}
      </span>
      <span className="tabular-nums">
        Ln {cursor.line}, Col {cursor.col}
      </span>
      {meta && (
        <button
          className="rounded px-1 hover:bg-raised hover:text-fg cursor-default"
          title="Change template"
          onClick={() => openGallery("change")}
        >
          {templateInfo(meta.template).label}
        </button>
      )}
      {meta && <span>{LANGUAGES.find((l) => l.id === meta.language)?.label ?? meta.language}</span>}
      {meta && (
        <SpellToggle
          language={meta.language}
          label={LANGUAGES.find((l) => l.id === meta.language)?.label ?? meta.language}
        />
      )}
    </footer>
  );
}
