import { syntaxTree } from "@codemirror/language";
import { forEachDiagnostic, lintGutter, setDiagnostics, setDiagnosticsEffect, type Diagnostic } from "@codemirror/lint";
import { Annotation, EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { LANGUAGES } from "@/lib/templates";
import { misspelled, suggestions } from "./client";
import type { DictionarySource } from "./protocol";
import {
  activeDictionary,
  addToProjectDictionary,
  addToUserDictionary,
  ignoreWord,
  listedWords,
  onSpellSettings,
} from "./settings";
import { isListed, spellTokens, type SpellToken } from "./tokens";

export { setSpellCheck, spellCheckEnabled, onSpellSettings } from "./settings";
export { dictionaryFor } from "./dictionaries";

const SOURCE = "spelling";
const DEBOUNCE_MS = 350;

/** Marks the transactions that publish spelling results, so the merge filter leaves them alone. */
const spellUpdate = Annotation.define<boolean>();

const live = new Set<SpellPlugin>();
onSpellSettings(() => {
  for (const plugin of live) plugin.schedule(0);
});

/** The current spelling diagnostic for `word` closest to where it was reported. */
function currentRange(view: EditorView, word: string, near: number): { from: number; to: number } | null {
  let best: { from: number; to: number } | null = null;
  forEachDiagnostic(view.state, (d, from, to) => {
    if (d.source !== SOURCE || view.state.sliceDoc(from, to) !== word) return;
    if (!best || Math.abs(from - near) < Math.abs(best.from - near)) best = { from, to };
  });
  return best;
}

function renderMessage(view: EditorView, dictionary: DictionarySource, token: SpellToken, message: string): Node {
  const dom = document.createElement("div");
  dom.className = "pf-spell-message";
  dom.append(message);
  const list = dom.appendChild(document.createElement("div"));
  list.className = "pf-spell-suggestions";
  list.textContent = "Looking for suggestions…";
  suggestions(dictionary, token.word).then(
    (words) => {
      list.textContent = words.length ? "" : "No suggestions";
      for (const word of words) {
        const button = list.appendChild(document.createElement("button"));
        button.type = "button";
        button.className = "cm-diagnosticAction";
        button.textContent = word;
        button.onmousedown = (e) => e.preventDefault();
        button.onclick = () => {
          const range = currentRange(view, token.word, token.from);
          if (range) view.dispatch({ changes: { ...range, insert: word }, userEvent: "input.spellcheck" });
        };
      }
    },
    () => (list.textContent = "No suggestions"),
  );
  return dom;
}

function spellingDiagnostic(dictionary: DictionarySource, token: SpellToken): Diagnostic {
  const language = LANGUAGES.find((l) => l.id === dictionary.language)?.label ?? dictionary.language;
  const message = `“${token.word}” is not in the ${language} dictionary.`;
  return {
    from: token.from,
    to: token.to,
    severity: "info",
    source: SOURCE,
    markClass: "pf-spell",
    message,
    renderMessage: (view) => renderMessage(view, dictionary, token, message),
    actions: [
      { name: "Add to project dictionary", apply: () => void addToProjectDictionary(token.word) },
      { name: "Add to my dictionary", apply: () => addToUserDictionary(token.word) },
      { name: "Ignore", apply: () => ignoreWord(token.word) },
    ],
  };
}

/** Checks the visible lines in the background, a moment after the last change. */
class SpellPlugin {
  private timer = 0;
  private run = 0;
  private typed = false;
  /** The word being typed when the last check ran; it is checked once the cursor leaves it. */
  private skipped: { from: number; to: number } | null = null;

  constructor(readonly view: EditorView) {
    live.add(this);
    this.schedule();
  }

  update(u: ViewUpdate) {
    if (u.docChanged) this.typed = true;
    if (u.docChanged || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) {
      this.schedule();
    } else if (u.selectionSet && this.skipped) {
      const head = u.state.selection.main.head;
      if (head < this.skipped.from || head > this.skipped.to) this.schedule();
    }
  }

  schedule(delay = DEBOUNCE_MS) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.check(), delay);
  }

  private async check() {
    const run = ++this.run;
    const { view } = this;
    const { state } = view;
    const dictionary = activeDictionary();
    const typing = this.typed && view.hasFocus && state.selection.main.empty;
    this.typed = false;
    this.skipped = null;
    if (!dictionary) return this.publish([]);

    const tree = syntaxTree(state);
    const head = typing ? state.selection.main.head : -1;
    const tokens: SpellToken[] = [];
    for (const range of view.visibleRanges) {
      const from = state.doc.lineAt(range.from).from;
      const to = state.doc.lineAt(range.to).to;
      for (const token of spellTokens(state.sliceDoc(from, to), from, tree)) {
        if (token.from <= head && head <= token.to) this.skipped = token;
        else if (!isListed(token.word, listedWords())) tokens.push(token);
      }
    }

    let bad: Set<string>;
    try {
      bad = await misspelled(dictionary, tokens.map((t) => t.word));
    } catch (e) {
      console.warn(`Spell check unavailable: ${e}`);
      bad = new Set();
    }
    if (run !== this.run || view.state.doc !== state.doc) return;
    this.publish(tokens.filter((t) => bad.has(t.word)).map((t) => spellingDiagnostic(dictionary, t)));
  }

  private publish(found: Diagnostic[]) {
    const { state } = this.view;
    const others: Diagnostic[] = [];
    let previous = 0;
    forEachDiagnostic(state, (d, from, to) => {
      if (d.source === SOURCE) previous++;
      else others.push({ ...d, from, to });
    });
    if (!previous && !found.length) return;
    this.view.dispatch({ ...setDiagnostics(state, [...others, ...found]), annotations: spellUpdate.of(true) });
  }

  destroy() {
    clearTimeout(this.timer);
    this.run++;
    live.delete(this);
  }
}

/**
 * The lint state holds one list of diagnostics; whoever sets it (the compile diagnostics in the
 * editor) would drop the spelling marks, so they are carried over into every other update.
 */
const keepSpelling = EditorState.transactionFilter.of((tr) => {
  if (!tr.effects.length || tr.annotation(spellUpdate)) return tr;
  let incoming: readonly Diagnostic[] | null = null;
  for (const e of tr.effects) if (e.is(setDiagnosticsEffect)) incoming = e.value;
  if (!incoming) return tr;
  const spelling: Diagnostic[] = [];
  forEachDiagnostic(tr.startState, (d, from, to) => {
    if (d.source !== SOURCE) return;
    const f = tr.changes.mapPos(from, 1);
    const t = tr.changes.mapPos(to, -1);
    if (f < t) spelling.push({ ...d, from: f, to: t });
  });
  if (!spelling.length) return tr;
  return [tr, { effects: setDiagnosticsEffect.of([...incoming, ...spelling]), sequential: true }];
});

const theme = EditorView.baseTheme({
  ".cm-lintRange.pf-spell": {
    backgroundImage: "none",
    textDecoration: "underline wavy color-mix(in srgb, var(--pf-danger, #d33) 75%, transparent)",
    textDecorationThickness: "1px",
    textUnderlineOffset: "3px",
  },
  ".pf-spell-suggestions": { marginTop: "4px", display: "flex", flexWrap: "wrap", gap: "2px" },
  ".pf-spell-suggestions .cm-diagnosticAction": { marginLeft: "0", marginRight: "4px", fontWeight: "600" },
});

/** Offline spell check of the prose in a Markdown part, reported as lint diagnostics. */
export const spellCheck: Extension = [
  ViewPlugin.fromClass(SpellPlugin),
  keepSpelling,
  lintGutter({ markerFilter: (diagnostics) => diagnostics.filter((d) => d.source !== SOURCE) }),
  theme,
];
