import { forEachDiagnostic, lintGutter, setDiagnostics, setDiagnosticsEffect, type Diagnostic } from "@codemirror/lint";
import { Annotation, EditorState, Facet, type Extension, type TransactionSpec } from "@codemirror/state";

/** A checker that reports diagnostics from the background, next to the compile diagnostics. */
export interface BackgroundSource {
  source: string;
  /** This source's marks are hidden where they fall inside a mark of that source. */
  yieldTo?: string;
}

const sources = Facet.define<BackgroundSource>();

/** Marks the transactions that publish background results, so the merge filter leaves them alone. */
const backgroundUpdate = Annotation.define<boolean>();

/** Drops the diagnostics whose source yields to another source's diagnostic around them. */
export function settle(diagnostics: readonly Diagnostic[], registered: readonly BackgroundSource[]): Diagnostic[] {
  const yieldTo = new Map(registered.filter((s) => s.yieldTo).map((s) => [s.source, s.yieldTo]));
  if (!yieldTo.size) return [...diagnostics];
  return diagnostics.filter((d) => {
    const other = d.source && yieldTo.get(d.source);
    return !other || !diagnostics.some((o) => o.source === other && o.from <= d.from && d.to <= o.to);
  });
}

/** The transaction that replaces `source`'s diagnostics with `found`, keeping everyone else's. */
export function publishSpec(state: EditorState, source: string, found: Diagnostic[]): TransactionSpec | null {
  const others: Diagnostic[] = [];
  let previous = 0;
  forEachDiagnostic(state, (d, from, to) => {
    if (d.source === source) previous++;
    else others.push({ ...d, from, to });
  });
  if (!previous && !found.length) return null;
  const diagnostics = settle([...others, ...found], state.facet(sources));
  return { ...setDiagnostics(state, diagnostics), annotations: backgroundUpdate.of(true) };
}

/**
 * The lint state holds one list of diagnostics; whoever sets it (the compile diagnostics in the
 * editor) would drop the background marks, so they are carried over into every other update.
 */
const keepBackground = EditorState.transactionFilter.of((tr) => {
  if (!tr.effects.length || tr.annotation(backgroundUpdate)) return tr;
  let incoming: readonly Diagnostic[] | null = null;
  for (const e of tr.effects) if (e.is(setDiagnosticsEffect)) incoming = e.value;
  if (!incoming) return tr;
  const names = new Set(tr.startState.facet(sources).map((s) => s.source));
  const carried: Diagnostic[] = [];
  forEachDiagnostic(tr.startState, (d, from, to) => {
    if (!d.source || !names.has(d.source)) return;
    const f = tr.changes.mapPos(from, 1);
    const t = tr.changes.mapPos(to, -1);
    if (f < t) carried.push({ ...d, from: f, to: t });
  });
  if (!carried.length) return tr;
  return [tr, { effects: setDiagnosticsEffect.of([...incoming, ...carried]), sequential: true }];
});

/** The gutter is for compile problems; background marks only show in the text. */
const gutter = lintGutter({
  markerFilter: (diagnostics, state) => {
    const names = new Set(state.facet(sources).map((s) => s.source));
    return diagnostics.filter((d) => !d.source || !names.has(d.source));
  },
});

/** Registers a background source whose diagnostics survive the other lint updates. */
export function backgroundDiagnostics(source: BackgroundSource): Extension {
  return [sources.of(source), keepBackground, gutter];
}
