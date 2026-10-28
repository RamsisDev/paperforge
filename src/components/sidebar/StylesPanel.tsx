import { Paintbrush, Plus, X } from "lucide-react";
import { useState } from "react";
import { withEditor } from "@/editor/bridge";
import { addStyleToProject, applyStyle } from "@/editor/styles";
import type { Style, StyleKind } from "@/lib/api";
import { BUILTIN_STYLES, projectStyles, styleDefinition, styleProblem, styleSyntax, validStyleName } from "@/lib/styles";
import { updateMeta } from "@/session";
import { isPartFile, store, useStore } from "@/store";
import { notify } from "../Toaster";
import { Button, Input, Select, Textarea, cx } from "../ui";

const NEW_STYLE_LATEX: Record<StyleKind, string> = {
  paragraph: "\\begin{quote}\n#1\n\\end{quote}",
  character: "\\emph{#1}",
};

function apply(style: Style) {
  if (!isPartFile(store.get().activeFile)) {
    notify("Open a part of the paper to apply a style", "error");
    return;
  }
  withEditor((view) => applyStyle(view, style));
}

function KindBadge({ kind }: { kind: StyleKind }) {
  return (
    <span className="rounded bg-raised px-1 py-px text-[10px] uppercase tracking-wide text-faint">
      {kind === "paragraph" ? "Paragraph" : "Character"}
    </span>
  );
}

function ApplyButton({ style }: { style: Style }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={`Apply ${style.name}`}
      title={`Apply to the selection: ${styleSyntax(style)} (again removes it)`}
      // Keeps the editor's selection, which a focused button would not show.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => apply(style)}
    >
      <Paintbrush size={13} /> Apply
    </Button>
  );
}

/** Div and span styles mapped to LaTeX: the user picks a name and sees, or edits, its LaTeX. */
export function StylesPanel() {
  const meta = useStore((s) => s.meta)!;
  const styles = projectStyles(meta);
  const offered = BUILTIN_STYLES.filter((b) => !styles.some((s) => s.name === b.name));
  const [name, setName] = useState("");
  const [kind, setKind] = useState<StyleKind>("paragraph");

  const setStyles = (next: Style[]) => updateMeta({ styles: next });
  const newName = name.trim();
  const nameProblem =
    newName && !validStyleName(newName)
      ? "Lowercase letters and digits, words joined by hyphens"
      : styles.some((s) => s.name === newName)
        ? "Already a style"
        : null;

  return (
    <section aria-labelledby="pf-styles-heading" className="space-y-3">
      <h3 id="pf-styles-heading" className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        Styles
      </h3>
      <p className="-mt-1.5 text-[11px] leading-snug text-faint">
        Apply wraps the selection as <code className="font-mono">::: {"{.name}"}</code> (paragraphs) or{" "}
        <code className="font-mono">[text]{"{.name}"}</code> (characters); applying again removes it. The LaTeX is
        typeset with <code className="font-mono">#1</code> as the text, and preamble.tex can redefine it.
      </p>

      {styles.length > 0 && (
        <ul aria-label="Project styles" className="space-y-2">
          {styles.map((style, i) => {
            const problem = styleProblem(style, styles);
            return (
              <li key={i} className="group relative space-y-1.5 rounded-lg border border-line bg-raised/50 p-2">
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">{style.name}</code>
                  <KindBadge kind={style.kind} />
                  <ApplyButton style={style} />
                </div>
                <Textarea
                  aria-label={`LaTeX of ${style.name}`}
                  className="font-mono text-xs"
                  maxRows={6}
                  value={style.latex}
                  onChange={(e) => setStyles(styles.map((s, j) => (j === i ? { ...s, latex: e.target.value } : s)))}
                />
                {problem ? (
                  <p role="alert" className="text-[11px] leading-snug text-danger">
                    {problem}
                  </p>
                ) : (
                  <p className="break-all font-mono text-[10px] leading-snug text-faint">{styleDefinition(style)}</p>
                )}
                <button
                  aria-label={`Remove style ${style.name}`}
                  title="Remove the style (styled text stays, typeset plain)"
                  onClick={() => setStyles(styles.filter((_, j) => j !== i))}
                  className="absolute -right-2 -top-2 hidden h-5 w-5 items-center justify-center rounded-full border border-line bg-panel text-muted shadow group-hover:flex hover:text-danger"
                >
                  <X size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {offered.length > 0 && (
        <ul aria-label="Built-in styles" className="space-y-1">
          {offered.map((style) => (
            <li key={style.name} className="flex items-center gap-2" title={styleDefinition(style)}>
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                {style.label} <code className="font-mono text-[11px] text-faint">.{style.name}</code>
              </span>
              <KindBadge kind={style.kind} />
              <ApplyButton style={style} />
              <Button size="sm" variant="ghost" aria-label={`Add ${style.name}`} onClick={() => addStyleToProject(style)}>
                <Plus size={13} />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="space-y-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newName || nameProblem) return;
          setStyles([...styles, { name: newName, kind, latex: NEW_STYLE_LATEX[kind] }]);
          setName("");
        }}
      >
        <div className="flex gap-1.5">
          <Input
            aria-label="New style name"
            className={cx("font-mono text-xs", nameProblem && "border-danger")}
            placeholder="new-style"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Select aria-label="New style kind" className="w-32 shrink-0" value={kind} onChange={(e) => setKind(e.target.value as StyleKind)}>
            <option value="paragraph">Paragraph</option>
            <option value="character">Character</option>
          </Select>
          <Button type="submit" size="sm" className="h-8 shrink-0" disabled={!newName || !!nameProblem}>
            <Plus size={13} /> Add
          </Button>
        </div>
        {nameProblem && <p className="text-[11px] text-danger">{nameProblem}</p>}
      </form>
    </section>
  );
}
