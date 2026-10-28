import { CircleAlert, CircleCheck, Cloud, LoaderCircle, SpellCheck, SpellCheck2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from "react";
import { dialectFor, grammarEnabled, onGrammarSettings, setGrammarCheck } from "@/editor/grammar";
import { dictionaryFor, onSpellSettings, setSpellCheck, spellCheckEnabled } from "@/editor/spell";
import type { Part, TemplateId } from "@/lib/api";
import { partInfo, totalWords } from "@/lib/parts";
import { LANGUAGES, templateInfo, unitName } from "@/lib/templates";
import { goalProgress, onWordGoals, sessionWords, setWordGoals, wordGoals, type WordGoals } from "@/lib/wordGoals";
import { openGallery, store, useStore } from "@/store";
import { Button, Field, Input } from "./ui";

/** Counting waits for a pause in typing. */
const COUNT_DELAY_MS = 400;

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

/** Grammar is checked in English only; for other languages the toggle is not shown. */
function GrammarToggle({ language }: { language: string }) {
  const enabled = useSyncExternalStore(onGrammarSettings, grammarEnabled);
  if (!dialectFor(language)) return null;
  return (
    <button
      className={`flex items-center rounded px-1 hover:bg-raised hover:text-fg cursor-default ${enabled ? "" : "text-faint"}`}
      title={enabled ? "Checking grammar. Click to turn it off" : "Grammar check is off. Click to turn it on"}
      aria-label="Grammar check"
      aria-pressed={enabled}
      onClick={() => setGrammarCheck(!enabled)}
    >
      <SpellCheck2 size={12} className={enabled ? "" : "opacity-50"} />
    </button>
  );
}

/** The project's parts as of the last pause in typing; a newly opened project is counted at once. */
function useCountedParts(): { dir: string | null; parts: Part[] } {
  const dir = useStore((s) => s.dir);
  const parts = useStore((s) => s.parts);
  const [counted, setCounted] = useState({ dir, parts });
  useEffect(() => {
    if (counted.dir !== dir) return setCounted({ dir, parts });
    if (counted.parts === parts) return;
    const timer = setTimeout(() => setCounted({ dir, parts }), COUNT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [dir, parts, counted]);
  return counted.dir === dir ? counted : { dir, parts };
}

function GoalBar({ value }: { value: number }) {
  return (
    <span className="h-1 w-10 overflow-hidden rounded-full bg-line" aria-hidden="true">
      <span className={`block h-full rounded-full ${value >= 1 ? "bg-ok" : "bg-accent"}`} style={{ width: `${value * 100}%` }} />
    </span>
  );
}

function goalInput(value: string): number | null {
  const n = Math.round(Number(value));
  return value.trim() && Number.isFinite(n) && n > 0 ? n : null;
}

function GoalPopover({ dir, goals, style, onClose }: { dir: string; goals: WordGoals; style: CSSProperties; onClose: () => void }) {
  const ref = useRef<HTMLFormElement>(null);
  const [total, setTotal] = useState(goals.total ? String(goals.total) : "");
  const [session, setSession] = useState(goals.session ? String(goals.session) : "");
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [onClose]);
  function submit(e: FormEvent) {
    e.preventDefault();
    setWordGoals(dir, { total: goalInput(total), session: goalInput(session) });
    onClose();
  }
  return (
    <form
      ref={ref}
      role="dialog"
      aria-label="Word goals"
      onSubmit={submit}
      style={style}
      className="fixed z-50 w-60 space-y-3 whitespace-normal rounded-lg border border-line bg-panel p-3 text-fg shadow-xl"
    >
      <Field label="Document goal" hint="words">
        <Input type="number" min={0} step={100} placeholder="No goal" value={total} autoFocus onChange={(e) => setTotal(e.target.value)} />
      </Field>
      <Field label="Session goal" hint="words added">
        <Input type="number" min={0} step={50} placeholder="No goal" value={session} onChange={(e) => setSession(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setWordGoals(dir, { total: null, session: null });
            onClose();
          }}
        >
          Clear
        </Button>
        <Button type="submit" size="sm" variant="primary">
          Set goal
        </Button>
      </div>
    </form>
  );
}

function WordCounter({ template, activeFile }: { template: TemplateId | undefined; activeFile: string }) {
  const { dir, parts } = useCountedParts();
  const goals = useSyncExternalStore(onWordGoals, () => wordGoals(dir));
  const [popover, setPopover] = useState<CSSProperties | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const words = useMemo(() => totalWords(parts), [parts]);
  const session = dir ? sessionWords(dir, words) : 0;
  const active = parts.find((p) => p.file === activeFile);
  const closePopover = useCallback(() => setPopover(null), []);

  function toggle() {
    const rect = button.current?.getBoundingClientRect();
    setPopover((open) => (open || !rect ? null : { right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.top + 6 }));
  }

  return (
    <div className="flex">
      <button
        ref={button}
        className="flex items-center gap-1.5 rounded px-1 hover:bg-raised hover:text-fg cursor-default"
        title="Words in the whole document, and in the file being edited. Click to set a word goal"
        aria-label="Word count"
        aria-expanded={popover !== null}
        onClick={toggle}
      >
        <span className="tabular-nums">
          {words.toLocaleString()}
          {goals.total && ` / ${goals.total.toLocaleString()}`} words
        </span>
        {goals.total && <GoalBar value={goalProgress(words, goals.total)} />}
        {goals.session ? (
          <>
            <span className="tabular-nums text-faint">
              · {session.toLocaleString()} / {goals.session.toLocaleString()} this session
            </span>
            <GoalBar value={goalProgress(session, goals.session)} />
          </>
        ) : (
          active &&
          parts.length > 1 && (
            <span className="text-faint">
              · {partInfo(active).words.toLocaleString()} in this {unitName(template)}
            </span>
          )
        )}
      </button>
      {popover && dir && <GoalPopover dir={dir} goals={goals} style={popover} onClose={closePopover} />}
    </div>
  );
}

export function StatusBar() {
  const compile = useStore((s) => s.compile);
  const diagnostics = useStore((s) => s.diagnostics);
  const cursor = useStore((s) => s.cursor);
  const meta = useStore((s) => s.meta);
  const saveState = useStore((s) => s.saveState);
  const saveError = useStore((s) => s.saveError);
  const activeFile = useStore((s) => s.activeFile);
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
      <WordCounter template={meta?.template} activeFile={activeFile} />
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
      {meta && <GrammarToggle language={meta.language} />}
    </footer>
  );
}
