// Writing mode: the Markdown rendered in place (Obsidian style), on the same EditorState as
// Source mode. Decorations only: the document is never changed to render, and every action
// through a widget is a local text change. The lines touched by the cursor or the selection
// show their source.
//
// Decorations cover a window around the viewport and are rebuilt per top-level block: an edit
// rebuilds the blocks it touched, scrolling builds the newly reached blocks, a cursor move only
// re-filters what is hidden on the old and new lines.

import { syntaxTree } from "@codemirror/language";
import {
  Compartment,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { store, useStore, type EditorMode } from "@/store";
import { buildRegion, topBlocks } from "./build";
import { REVEAL, writingExtensions } from "./registry";
import { activeSpans, expandRegion, touchesActive, type Span } from "./syntax";
import { forgetImages } from "./widgets";
import "./table";

export {
  previewReplace,
  registerBlockWidget,
  registerInlineWidget,
  registerWritingExtension,
  type BlockWidgetProvider,
  type InlineWidgetFactory,
  type PreviewBlock,
} from "./registry";
export { ChipWidget, FenceLabelWidget, FigureWidget, MathWidget, SourceWidget } from "./widgets";
export type { InlineKind, InlineToken } from "./syntax";

/** Characters built beyond the viewport on each side, so short scrolls need no rebuild. */
const MARGIN = 4000;

/** Asks the field to cover a range (the viewport plus margin). */
const coverRange = StateEffect.define<Span>();
/** Rebuilds everything covered: chip texts depend on refs.bib, labels and the language. */
export const refreshPreview = StateEffect.define<null>();

class BlockExtent extends RangeValue {}
const BLOCK = new BlockExtent();

interface Built {
  /** The block-aligned range `all` was built for; null before anything was built. */
  covered: Span | null;
  /** Every decoration in `covered`. */
  all: DecorationSet;
  /** The extent of each block `all` was built from, so a rebuild can drop a block whole. */
  blocks: RangeSet<BlockExtent>;
}

const EMPTY: Built = { covered: null, all: Decoration.none, blocks: RangeSet.empty };

interface Preview extends Built {
  /** `all` minus the source-hiding decorations on the active lines. */
  shown: DecorationSet;
  active: Span[];
}

function clip(state: EditorState, from: number, to: number): Span {
  const len = state.doc.length;
  return { from: Math.max(0, Math.min(from, len)), to: Math.max(0, Math.min(to, len)) };
}

/** Rebuilds the whole blocks touching `from`..`to` and adds them to the covered range. */
function rebuild(state: EditorState, value: Built, from: number, to: number): Built {
  const tree = syntaxTree(state);
  const range = clip(state, from, to);
  const region = expandRegion(range.from, range.to, (a, b) => {
    const spans: Span[] = topBlocks(tree, a, b);
    value.blocks.between(a, b, (f, t) => void spans.push({ from: f, to: t }));
    return spans;
  });
  const outside = (f: number, t: number) => t < region.from || f > region.to;
  const all = value.all.update({
    filter: outside,
    filterFrom: region.from,
    filterTo: region.to,
    add: buildRegion(state, region.from, region.to),
    sort: true,
  });
  const blocks = value.blocks.update({
    filter: outside,
    filterFrom: region.from,
    filterTo: region.to,
    add: topBlocks(tree, region.from, region.to).map((b) => BLOCK.range(b.from, b.to)),
  });
  const covered = value.covered
    ? { from: Math.min(value.covered.from, region.from), to: Math.max(value.covered.to, region.to) }
    : region;
  return { covered, all, blocks };
}

function reveal(all: DecorationSet, active: Span[]): DecorationSet {
  if (!active.length) return all;
  return all.update({
    filter: (f, t, d) => !d.spec[REVEAL] || !touchesActive(f, t, active),
    filterFrom: active[0].from,
    filterTo: active[active.length - 1].to,
  });
}

function activeOf(state: EditorState): Span[] {
  return activeSpans(state.selection.ranges, (pos) => state.doc.lineAt(pos));
}

function sameSpans(a: Span[], b: Span[]) {
  return a.length === b.length && a.every((s, i) => s.from === b[i].from && s.to === b[i].to);
}

function overlapsCovered(covered: Span | null, from: number, to: number) {
  return covered !== null && from <= covered.to && to >= covered.from;
}

function updatePreview(value: Preview, tr: Transaction): Preview {
  let next: Built = value;
  const { state, startState } = tr;
  let inserted = 0;
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => (inserted += toB - fromB));
  if (inserted > 2 * MARGIN) {
    const head = state.selection.main.head;
    next = rebuild(state, EMPTY, head - MARGIN, head + MARGIN);
  } else if (tr.docChanged && value.covered) {
    const covered = { from: tr.changes.mapPos(value.covered.from, -1), to: tr.changes.mapPos(value.covered.to, 1) };
    next = { covered, all: value.all.map(tr.changes), blocks: value.blocks.map(tr.changes) };
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      if (overlapsCovered(next.covered, fromB, toB)) next = rebuild(state, next, fromB, toB);
    });
  } else if (!tr.docChanged) {
    const tree = syntaxTree(state);
    const before = syntaxTree(startState);
    if (tree !== before && value.covered && before.length < value.covered.to) {
      next = rebuild(state, next, Math.max(value.covered.from, before.length), value.covered.to);
    }
  }
  for (const e of tr.effects) {
    if (e.is(refreshPreview) && next.covered) {
      next = rebuild(state, EMPTY, next.covered.from, next.covered.to);
    } else if (e.is(coverRange)) {
      const want = clip(state, e.value.from, e.value.to);
      const c = next.covered;
      if (!c || want.to < c.from || want.from > c.to) {
        next = rebuild(state, EMPTY, want.from, want.to);
      } else {
        if (want.from < c.from) next = rebuild(state, next, want.from, c.from);
        if (want.to > c.to) next = rebuild(state, next, c.to, want.to);
      }
    }
  }
  const active = tr.selection || tr.docChanged ? activeOf(state) : value.active;
  if (next.all === value.all && sameSpans(active, value.active)) return value;
  return { ...next, active, shown: reveal(next.all, active) };
}

const previewField = StateField.define<Preview>({
  create(state) {
    const head = state.selection.main.head;
    const built = rebuild(state, EMPTY, head - MARGIN, head + MARGIN);
    const active = activeOf(state);
    return { ...built, active, shown: reveal(built.all, active) };
  },
  update: updatePreview,
  provide: (f) => EditorView.decorations.from(f, (v) => v.shown),
});

/** The decorations Writing mode shows in `state`, or null in Source mode. */
export function previewDecorations(state: EditorState): { covered: Span | null; shown: DecorationSet; all: DecorationSet } | null {
  return state.field(previewField, false) ?? null;
}

/** Keeps the viewport covered and refreshes chips when the project data they show changes. */
const coverage = ViewPlugin.fromClass(
  class {
    private pending = new Set<string>();
    private unsubscribe: () => void;

    constructor(readonly view: EditorView) {
      this.check();
      this.unsubscribe = useStore.subscribe((s, prev) => {
        if (s.figures !== prev.figures || s.dir !== prev.dir) forgetImages();
        if (
          s.bib !== prev.bib ||
          s.labels !== prev.labels ||
          s.dir !== prev.dir ||
          s.figures !== prev.figures ||
          s.meta?.language !== prev.meta?.language
        ) {
          this.later("refresh", () => this.view.dispatch({ effects: refreshPreview.of(null) }));
        }
      });
    }

    update(u: ViewUpdate) {
      if (u.viewportChanged || u.docChanged) this.check();
    }

    private check() {
      const { from, to } = this.view.viewport;
      const covered = this.view.state.field(previewField).covered;
      if (covered && from >= covered.from && to <= covered.to) return;
      this.later("cover", () => {
        const { from, to } = this.view.viewport;
        const c = this.view.state.field(previewField, false)?.covered;
        if (c !== undefined && (!c || from < c.from || to > c.to)) {
          this.view.dispatch({ effects: coverRange.of({ from: from - MARGIN, to: to + MARGIN }) });
        }
      });
    }

    /** Runs after the current view update, before the next paint. */
    private later(key: string, action: () => void) {
      if (this.pending.has(key)) return;
      this.pending.add(key);
      queueMicrotask(() => {
        this.pending.delete(key);
        if (this.view.state.field(previewField, false)) action();
      });
    }

    destroy() {
      this.unsubscribe();
    }
  },
);

let writing: Extension | null = null;

/** The Writing-mode extension, with everything registered through the widget registry. */
export function writingMode(): Extension {
  writing ??= [previewField, coverage, EditorView.editorAttributes.of({ class: "pf-writing" }), ...writingExtensions()];
  return writing;
}

/** Holds `writingMode()` or nothing; reconfiguring it keeps the undo history and selection. */
export const editorMode = new Compartment();

const SOURCE: Extension = [];

function modeExtension(mode: EditorMode): Extension {
  return mode === "writing" ? writingMode() : SOURCE;
}

/** The compartment for a Markdown part, in the user's current mode. */
export function editorModeExtension(): Extension {
  return editorMode.of(modeExtension(store.get().editorMode));
}

/** Brings the view in line with the user's mode; stored states of other parts may predate a switch. */
export function syncEditorMode(view: EditorView) {
  const current = editorMode.get(view.state);
  if (current === undefined) return;
  const want = modeExtension(store.get().editorMode);
  if (current !== want) view.dispatch({ effects: editorMode.reconfigure(want) });
}
