import {
  codeFolding,
  ensureSyntaxTree,
  foldEffect,
  foldService,
  foldState,
  foldedRanges,
  syntaxTree,
  unfoldAll,
  unfoldCode,
  unfoldEffect,
} from "@codemirror/language";
import { RangeSet, RangeSetBuilder, type EditorState, type Extension, type StateEffect } from "@codemirror/state";
import { GutterMarker, ViewPlugin, gutter, keymap, type Command, type EditorView, type ViewUpdate } from "@codemirror/view";
import { markdownFold, type FoldRange } from "./foldRanges";

/** Time allowed to finish parsing before a fold that may reach past the parsed part. */
const PARSE_BUDGET_MS = 100;

const CHEVRON =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.25" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

class FoldMarker extends GutterMarker {
  constructor(readonly open: boolean) {
    super();
  }
  eq(other: FoldMarker) {
    return other.open === this.open;
  }
  toDOM() {
    const dom = document.createElement("span");
    dom.className = this.open ? "pf-fold pf-fold-open" : "pf-fold pf-fold-closed";
    dom.title = this.open ? "Fold" : "Unfold";
    dom.innerHTML = CHEVRON;
    return dom;
  }
}

const canFold = new FoldMarker(true);
const canUnfold = new FoldMarker(false);

function foldedAt(state: EditorState, from: number, to: number): FoldRange | null {
  let found: FoldRange | null = null;
  foldedRanges(state).between(from, to, (a, b) => {
    if (!found || found.from > a) found = { from: a, to: b };
  });
  return found;
}

/** The fold for a line, with the whole document parsed when that fits in the budget. */
function fullFold(state: EditorState, lineFrom: number): FoldRange | null {
  return markdownFold(state, lineFrom, ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state));
}

function toggleLine(view: EditorView, from: number, to: number): boolean {
  const folded = foldedAt(view.state, from, to);
  const range = folded ? null : fullFold(view.state, from);
  if (folded) view.dispatch({ effects: unfoldEffect.of(folded) });
  else if (range) view.dispatch({ effects: foldEffect.of(range) });
  return !!(folded || range);
}

const foldHere: Command = (view) => {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const range = foldedAt(view.state, line.from, line.to) ? null : fullFold(view.state, line.from);
  if (range) view.dispatch({ effects: foldEffect.of(range) });
  return !!range;
};

/** Folds every outermost section and block, like an outline. */
const foldEverything: Command = (view) => {
  const { state } = view;
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state);
  const effects: StateEffect<FoldRange>[] = [];
  for (let pos = 0; pos <= state.doc.length; ) {
    const line = state.doc.lineAt(pos);
    const folded = foldedAt(state, line.from, line.to);
    const range = folded ?? markdownFold(state, line.from, tree);
    if (range && !folded) effects.push(foldEffect.of(range));
    pos = (range ? state.doc.lineAt(range.to) : line).to + 1;
  }
  if (effects.length) view.dispatch({ effects });
  return true;
};

const foldMarkers = ViewPlugin.fromClass(
  class {
    markers: RangeSet<GutterMarker>;
    constructor(view: EditorView) {
      this.markers = this.build(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state) ||
        u.startState.field(foldState, false) !== u.state.field(foldState, false)
      ) {
        this.markers = this.build(u.view);
      }
    }
    build(view: EditorView): RangeSet<GutterMarker> {
      const builder = new RangeSetBuilder<GutterMarker>();
      const anyFolded = foldedRanges(view.state).size > 0;
      for (const line of view.viewportLineBlocks) {
        const mark =
          anyFolded && foldedAt(view.state, line.from, line.to) ? canUnfold : markdownFold(view.state, line.from) ? canFold : null;
        if (mark) builder.add(line.from, line.from, mark);
      }
      return builder.finish();
    }
  },
);

/**
 * Outline folding for Markdown: a gutter that only offers headings, fenced code, `$$` math and
 * `:::` divs (not every multi-line paragraph), and fold/unfold-all commands.
 */
export const markdownFolding: Extension = [
  foldService.of((state, lineStart) => markdownFold(state, lineStart)),
  codeFolding(),
  foldMarkers,
  gutter({
    class: "cm-foldGutter pf-fold-gutter",
    markers: (view) => view.plugin(foldMarkers)?.markers ?? RangeSet.empty,
    initialSpacer: () => canFold,
    domEventHandlers: { click: (view, line) => toggleLine(view, line.from, line.to) },
  }),
  keymap.of([
    { key: "Mod-Alt-[", run: foldEverything },
    { key: "Mod-Alt-]", run: unfoldAll },
    { key: "Ctrl-Shift-[", run: foldHere },
    { key: "Ctrl-Shift-]", run: unfoldCode },
  ]),
];
