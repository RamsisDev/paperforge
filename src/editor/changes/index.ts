// Tracked changes in the editor: insertions are underlined and deletions struck through in both
// modes, Writing mode hides their brackets and attributes off the cursor's lines, and hovering a
// change offers Accept and Reject. While Track changes is on, `trackingFilter` records edits.
// Only the changes around the viewport are parsed.

import type { ChangeDesc, EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, hoverTooltip, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { commentDate } from "@/editor/comments/model";
import { previewDecorations, registerInlineWidget } from "@/editor/livepreview";
import { activeSpans, touchesActive } from "@/editor/livepreview/syntax";
import { notify } from "@/components/Toaster";
import { setTrackChanges, store } from "@/store";
import { DELETION_CLASS, INSERTION_CLASS, changeAt, parseChanges, resolveChanges, type Change, type ChangeKind } from "./model";
import { paragraphsAround, trackingFilter, untracked } from "./track";
import "./changes.css";

export function describeChange(c: { kind: ChangeKind; author: string; date: string }): string {
  const verb = c.kind === INSERTION_CLASS ? "Inserted" : "Deleted";
  return [`${verb} by ${c.author || "Anonymous"}`, c.date.replace("T", " ")].filter(Boolean).join(" · ");
}

function changesBetween(state: EditorState, from: number, to: number): Change[] {
  const range = paragraphsAround(state, from, to);
  return parseChanges(state.sliceDoc(range.from, range.to), range.from);
}

/** Accepts or rejects one change of the view's document, as one undoable transaction. */
export function resolveInView(view: EditorView, change: Change, accept: boolean) {
  const current = changesBetween(view.state, change.from, change.from).find((c) => c.from === change.from && c.to === change.to);
  if (!current) return;
  const doc = view.state.doc;
  const charAt = (pos: number) => (pos >= 0 && pos < doc.length ? doc.sliceString(pos, pos + 1) : "");
  view.dispatch({ changes: resolveChanges([current], accept, charAt), userEvent: "input.review", annotations: untracked.of(true) });
}

// Accept / reject on hover -------------------------------------------------------------------

function tipButton(label: string, text: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pf-change-tip-button";
  button.textContent = text;
  button.setAttribute("aria-label", label);
  button.addEventListener("mousedown", (e) => {
    e.preventDefault();
    onClick();
  });
  return button;
}

const changeTooltip = hoverTooltip(
  (view, pos) => {
    const change = changeAt(changesBetween(view.state, pos, pos), pos);
    if (!change || pos < change.textFrom || pos > change.textTo) return null;
    return {
      pos: change.textFrom,
      end: change.textTo,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "pf-change-tip";
        dom.setAttribute("role", "group");
        dom.setAttribute("aria-label", "Tracked change");
        const label = document.createElement("span");
        label.className = "pf-change-tip-label";
        label.textContent = describeChange(change);
        dom.append(
          label,
          tipButton("Accept change", "Accept", () => resolveInView(view, change, true)),
          tipButton("Reject change", "Reject", () => resolveInView(view, change, false)),
        );
        return { dom };
      },
    };
  },
  { hideOnChange: true, hoverTime: 400 },
);

// Highlights ---------------------------------------------------------------------------------

const HIDDEN = Decoration.replace({});
/** Characters parsed beyond the viewport on each side, so short scrolls need no parse. */
const MARGIN = 2000;
const MARKS: Record<ChangeKind, string> = { [INSERTION_CLASS]: "pf-insertion", [DELETION_CLASS]: "pf-deletion" };

type Shown = Pick<Change, "kind" | "from" | "to" | "textFrom" | "textTo" | "attrsFrom" | "author" | "date">;

function mapShown(c: Shown, changes: ChangeDesc): Shown {
  const map = (pos: number) => changes.mapPos(pos);
  return { ...c, from: map(c.from), to: map(c.to), textFrom: map(c.textFrom), textTo: map(c.textTo), attrsFrom: map(c.attrsFrom) };
}

/** The lines whose change brackets show: the cursor's, in Writing mode only. */
function activeLines(state: EditorState): string {
  if (previewDecorations(state) === null) return "";
  return state.selection.ranges.map((r) => `${state.doc.lineAt(r.from).number}-${state.doc.lineAt(r.to).number}`).join(",");
}

function highlightDecorations(state: EditorState, changes: readonly Shown[]): DecorationSet {
  if (changes.length === 0) return Decoration.none;
  const writing = previewDecorations(state) !== null;
  const active = writing ? activeSpans(state.selection.ranges, (pos) => state.doc.lineAt(pos)) : [];
  const out: Range<Decoration>[] = [];
  for (const c of changes) {
    if (c.textFrom < c.textTo) {
      out.push(Decoration.mark({ class: MARKS[c.kind], attributes: { title: describeChange(c) } }).range(c.textFrom, c.textTo));
    }
    if (writing) {
      if (!touchesActive(c.from, c.textFrom, active)) out.push(HIDDEN.range(c.from, c.textFrom));
      if (!touchesActive(c.textTo, c.attrsFrom, active)) out.push(HIDDEN.range(c.textTo, c.attrsFrom));
    }
  }
  return Decoration.set(out, true);
}

/** Changes parsed around the viewport; an edit re-parses only the paragraphs it touched. */
const changeHighlights = ViewPlugin.fromClass(
  class {
    covered = { from: 0, to: 0 };
    changes: Shown[] = [];
    active = "";
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.cover(view);
      this.active = activeLines(view.state);
      this.decorations = highlightDecorations(view.state, this.changes);
    }

    private cover(view: EditorView) {
      const { from, to } = view.viewport;
      const length = view.state.doc.length;
      this.covered = paragraphsAround(view.state, Math.max(0, from - MARGIN), Math.min(length, to + MARGIN));
      this.changes = parseChanges(view.state.sliceDoc(this.covered.from, this.covered.to), this.covered.from);
    }

    update(u: ViewUpdate) {
      let reparsed = false;
      if (u.docChanged) {
        let from = u.state.doc.length;
        let to = 0;
        u.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
          from = Math.min(from, fromB);
          to = Math.max(to, toB);
        });
        const region = paragraphsAround(u.state, from, to);
        const mapped = this.changes.map((c) => mapShown(c, u.changes));
        const kept = mapped.filter((c) => c.to < region.from || c.from > region.to);
        const fresh = parseChanges(u.state.sliceDoc(region.from, region.to), region.from);
        reparsed = fresh.length > 0 || kept.length < mapped.length;
        this.changes = reparsed ? [...kept, ...fresh].sort((a, b) => a.from - b.from) : mapped;
        this.covered = {
          from: Math.min(u.changes.mapPos(this.covered.from, -1), region.from),
          to: Math.max(u.changes.mapPos(this.covered.to, 1), region.to),
        };
      }
      const { from, to } = u.view.viewport;
      if (u.viewportChanged && (from < this.covered.from || to > this.covered.to)) {
        this.cover(u.view);
        reparsed = true;
      }
      const active = activeLines(u.state);
      const moved = active !== this.active;
      this.active = active;
      if (!reparsed && !(moved && this.changes.length > 0)) {
        if (u.docChanged) this.decorations = this.decorations.map(u.changes);
        return;
      }
      this.decorations = highlightDecorations(u.state, this.changes);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Stands in for the attributes of a change in Writing mode: nothing to read, only a hover title. */
class ChangeMarker extends WidgetType {
  constructor(readonly title: string) {
    super();
  }

  eq(other: ChangeMarker) {
    return other.title === this.title;
  }

  toDOM() {
    const dom = document.createElement("span");
    dom.className = "pf-change-marker";
    dom.title = this.title;
    return dom;
  }
}

registerInlineWidget("attr", (token) => {
  const kind = ([INSERTION_CLASS, DELETION_CLASS] as const).find((k) => token.attrs.classes.includes(k));
  if (!kind) return null;
  const { author = "", date = "" } = token.attrs.pairs;
  return new ChangeMarker(describeChange({ kind, author, date }));
});

/** Turns Track changes on or off for the project. */
export function toggleTrackChanges(on: boolean) {
  setTrackChanges(on);
  if (on && !store.get().commentAuthor) notify("Changes are signed “Anonymous” until you give your name in the Review panel.");
}

let blockedNotice = false;

export const trackChanges: Extension = [
  trackingFilter({
    settings: () => {
      const { trackChanges, commentAuthor } = store.get();
      return trackChanges ? { author: commentAuthor, date: commentDate() } : null;
    },
    onBlocked: () => {
      if (blockedNotice) return;
      blockedNotice = true;
      setTimeout(() => (blockedNotice = false), 1500);
      queueMicrotask(() => notify("That edit would cut through a tracked change or comment; select inside or around it.", "error"));
    },
  }),
  changeHighlights,
  changeTooltip,
];
