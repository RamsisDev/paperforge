import { SlidersHorizontal, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  figureAttribute,
  figureId,
  hasClass,
  setAttribute,
  setCaption,
  setClass,
  setId,
  setWidth,
  widthPercent,
  type Figure,
  type TextChange,
} from "@/editor/figureSyntax";
import { Checkbox, Field, IconButton, Input } from "./ui";

export type FigureEdit = (fig: Figure) => TextChange[];

/** Text the user is typing; follows the document again once the input loses focus. */
function useDraft(value: string) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  return { draft, setDraft, onFocus: () => setFocused(true), onBlur: () => setFocused(false) };
}

const LABEL_CHARS = /^[\w:.-]*$/;

export function FigureInspector({
  figure,
  apply,
  takenLabels,
  onDone,
}: {
  figure: Figure;
  apply: (edit: FigureEdit) => void;
  /** Labels used anywhere in the document, this figure's included. */
  takenLabels: () => string[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const caption = useDraft(figure.caption.text);
  const id = figureId(figure);
  const label = useDraft(id);
  const alt = useDraft(figureAttribute(figure, "alt") ?? "");
  const width = figureAttribute(figure, "width");
  const percent = widthPercent(figure);
  const wide = hasClass(figure, "wide");

  const labelProblem = !LABEL_CHARS.test(label.draft)
    ? "Letters, digits, - _ : . only"
    : label.draft !== id && takenLabels().includes(label.draft)
      ? "Already used"
      : null;

  function commitLabel() {
    if (labelProblem) label.setDraft(id);
    else apply((fig) => setId(fig, label.draft));
  }

  if (!open) {
    return (
      <button
        type="button"
        className="flex h-6 items-center gap-1 px-2 text-[11px] font-medium text-muted hover:bg-raised hover:text-fg cursor-default"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal size={12} /> Edit figure
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Figure"
      className="w-72 space-y-2.5 p-3"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        setOpen(false);
        onDone();
      }}
    >
      <div className="flex items-center justify-between">
        <span className="truncate font-mono text-[11px] text-faint" title={figure.src.text}>
          {figure.src.text}
        </span>
        <IconButton
          label="Close"
          className="h-6 w-6"
          onClick={() => {
            setOpen(false);
            onDone();
          }}
        >
          <X size={13} />
        </IconButton>
      </div>
      <Field label="Caption">
        <Input
          aria-label="Caption"
          value={caption.draft}
          onFocus={caption.onFocus}
          onBlur={caption.onBlur}
          onChange={(e) => {
            caption.setDraft(e.target.value);
            apply((fig) => setCaption(fig, e.target.value));
          }}
        />
      </Field>
      <Field label="Label" hint={labelProblem ?? (id ? `reference with @${id}` : "needed for references")}>
        <Input
          aria-label="Label"
          placeholder="fig:name"
          className="font-mono"
          value={label.draft}
          onFocus={label.onFocus}
          onBlur={() => {
            label.onBlur();
            commitLabel();
          }}
          onChange={(e) => label.setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && commitLabel()}
        />
      </Field>
      <Field
        label="Width"
        hint={
          width === null ? (
            "natural size"
          ) : (
            <button type="button" className="hover:text-fg cursor-default" onClick={() => apply((fig) => setWidth(fig, null))}>
              {width} · reset
            </button>
          )
        }
      >
        <input
          type="range"
          aria-label="Width"
          min={10}
          max={100}
          step={5}
          value={percent ?? 100}
          onChange={(e) => apply((fig) => setWidth(fig, Number(e.target.value)))}
          className="w-full accent-[var(--pf-accent)]"
        />
      </Field>
      <Checkbox
        checked={wide}
        onChange={(on) => apply((fig) => setClass(fig, "wide", on))}
        label="Span both columns"
        hint="Adds .wide; for two-column templates"
      />
      <Field label="Alt text" hint="for screen readers">
        <Input
          aria-label="Alt text"
          placeholder="Same as the caption"
          value={alt.draft}
          onFocus={alt.onFocus}
          onBlur={alt.onBlur}
          onChange={(e) => {
            alt.setDraft(e.target.value);
            apply((fig) => setAttribute(fig, "alt", e.target.value || null));
          }}
        />
      </Field>
    </div>
  );
}
