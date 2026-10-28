import { Replace, ReplaceAll, Search } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, type ReactNode } from "react";
import { editorBridge } from "@/editor/bridge";
import { findAcrossParts, findInText, replacementChanges, type FindOptions, type TextMatch } from "@/editor/findAcrossParts";
import { partTitle } from "@/lib/parts";
import { selectInFile, store, updateFind, useStore } from "@/store";
import { notify } from "../Toaster";
import { Button, Checkbox, IconButton, Input, MOD, SHIFT, cx } from "../ui";

function currentOptions(): FindOptions {
  const { query, regex, matchCase, wholeWord, skipMarkup } = store.get().find;
  return { query, regex, matchCase, wholeWord, skipMarkup };
}

/**
 * Replaces the matches of the current search in one part, or only `only` when it still matches.
 * Matches are searched again on the part's current text, so offsets are never stale.
 */
function replaceInPart(file: string, only?: TextMatch): number {
  const part = store.get().parts.find((p) => p.file === file);
  const edit = editorBridge.edit;
  if (!part || !edit) return 0;
  const opts = currentOptions();
  let matches = findInText(part.content, opts);
  if (only) matches = matches.filter((m) => m.from === only.from && m.to === only.to);
  if (matches.length === 0) return 0;
  edit(file, replacementChanges(part.content, matches, store.get().find.replace, opts.regex));
  return matches.length;
}

function replaceEverywhere(files: string[]) {
  let total = 0;
  let parts = 0;
  for (const file of files) {
    const n = replaceInPart(file);
    total += n;
    if (n) parts++;
  }
  notify(`Replaced ${total} match${total === 1 ? "" : "es"} in ${parts} part${parts === 1 ? "" : "s"}`);
}

function Toggle({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <IconButton
      label={label}
      active={active}
      aria-pressed={active}
      onClick={onClick}
      className={cx("w-auto px-1.5 font-mono text-[11px]", active && "text-accent")}
    >
      {children}
    </IconButton>
  );
}

function Preview({ match }: { match: TextMatch }) {
  const start = match.from - match.lineFrom;
  const end = Math.min(match.to - match.lineFrom, match.lineText.length);
  const lead = Math.max(0, start - 24);
  return (
    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
      {lead > 0 && "…"}
      {match.lineText.slice(lead, start)}
      <mark className="rounded-sm bg-accent-soft px-px text-accent">{match.lineText.slice(start, end) || "⏎"}</mark>
      {match.lineText.slice(end, end + 120)}
    </span>
  );
}

export function FindPanel() {
  const find = useStore((s) => s.find);
  const parts = useDeferredValue(useStore((s) => s.parts));
  const search = useDeferredValue(find);
  const query = useRef<HTMLInputElement>(null);
  const { query: q, regex, matchCase, wholeWord, skipMarkup } = search;
  const result = useMemo(
    () => findAcrossParts(parts, { query: q, regex, matchCase, wholeWord, skipMarkup }),
    [parts, q, regex, matchCase, wholeWord, skipMarkup],
  );
  const titles = useMemo(() => new Map(parts.map((p) => [p.file, partTitle(p)])), [parts]);

  useEffect(() => {
    query.current?.focus();
    query.current?.select();
  }, [find.focus]);

  const files = result.parts.map((p) => p.file);
  const summary = result.error
    ? result.error
    : !q
      ? `Search every part. ${MOD}${SHIFT}F searches the selection.`
      : result.total === 0
        ? "No matches."
        : `${result.truncated ? "First " : ""}${result.total} match${result.total === 1 ? "" : "es"} in ${result.parts.length} part${result.parts.length === 1 ? "" : "s"}`;

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            ref={query}
            aria-label="Find in all parts"
            value={find.query}
            onChange={(e) => updateFind({ query: e.target.value })}
            placeholder="Find in all parts"
            className="pl-8"
            spellCheck={false}
          />
        </div>
        <div className="relative">
          <Replace size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            aria-label="Replace with"
            value={find.replace}
            onChange={(e) => updateFind({ replace: e.target.value })}
            placeholder={find.regex ? "Replace with ($1 for groups)" : "Replace with"}
            className="pl-8"
            spellCheck={false}
          />
        </div>
        <div className="flex items-center gap-0.5">
          <Toggle label="Match case" active={find.matchCase} onClick={() => updateFind({ matchCase: !find.matchCase })}>
            Aa
          </Toggle>
          <Toggle label="Whole word" active={find.wholeWord} onClick={() => updateFind({ wholeWord: !find.wholeWord })}>
            ab
          </Toggle>
          <Toggle label="Regular expression" active={find.regex} onClick={() => updateFind({ regex: !find.regex })}>
            .*
          </Toggle>
          <Button
            size="sm"
            className="ml-auto"
            disabled={result.total === 0 || result.error !== null}
            onClick={() => replaceEverywhere(files)}
          >
            <ReplaceAll size={13} /> Replace all
          </Button>
        </div>
        <Checkbox
          checked={find.skipMarkup}
          onChange={(skipMarkup) => updateFind({ skipMarkup })}
          label="Skip math, code and citations"
          hint="Also attributes and raw LaTeX."
        />
        <p className={cx("text-[11px]", result.error ? "text-danger" : "text-faint")}>{summary}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1.5" aria-label="Find results">
        {result.parts.map((group) => (
          <section key={group.file} className="mb-1.5" aria-label={titles.get(group.file) ?? group.file}>
            <div className="group/part flex items-center gap-2 px-2 py-1">
              <span className="min-w-0 truncate text-[12px] font-semibold text-fg" title={group.file}>
                {titles.get(group.file) ?? group.file}
              </span>
              <span className="shrink-0 rounded bg-raised px-1 text-[10px] text-muted">{group.matches.length}</span>
              <button
                className="ml-auto hidden shrink-0 text-[11px] text-faint hover:text-accent group-hover/part:block cursor-default"
                onClick={() => replaceInPart(group.file)}
              >
                Replace in part
              </button>
            </div>
            {group.matches.map((m) => (
              <div key={m.from} className="group/match flex items-center rounded-md hover:bg-raised">
                <button
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left cursor-default"
                  onClick={() => selectInFile(group.file, m.line, m.from, m.to)}
                >
                  <span className="w-7 shrink-0 text-right font-mono text-[10px] text-faint">{m.line + 1}</span>
                  <Preview match={m} />
                </button>
                <IconButton
                  label="Replace"
                  className="mr-1 h-6 w-6 opacity-0 group-hover/match:opacity-100 focus-visible:opacity-100"
                  onClick={() => replaceInPart(group.file, m)}
                >
                  <Replace size={12} />
                </IconButton>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
