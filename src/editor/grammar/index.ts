import { syntaxTree } from "@codemirror/language";
import type { Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { backgroundDiagnostics, publishSpec } from "../backgroundLint";
import { onSpellSettings, SPELLING_SOURCE } from "../spell";
import { lintParagraphs } from "./client";
import { findGrammar, GRAMMAR_SOURCE } from "./diagnostics";
import { activeDialect, ignoredLints, ignoreLint, onGrammarSettings } from "./settings";

export { grammarEnabled, onGrammarSettings, setGrammarCheck } from "./settings";
export { dialectFor } from "./dialects";

const DEBOUNCE_MS = 600;

const live = new Set<GrammarPlugin>();
const recheckAll = () => {
  for (const plugin of live) plugin.schedule(0);
};
onGrammarSettings(recheckAll);
// Marks hidden under a spelling mark come back when the word is accepted.
onSpellSettings(recheckAll);

/** Checks the paragraphs on screen in the background, a moment after the last change. */
class GrammarPlugin {
  private timer = 0;
  private run = 0;

  constructor(readonly view: EditorView) {
    live.add(this);
    this.schedule();
  }

  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) this.schedule();
  }

  schedule(delay = DEBOUNCE_MS) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.check(), delay);
  }

  private async check() {
    const run = ++this.run;
    const { view } = this;
    const { state } = view;
    const dialect = activeDialect();
    if (!dialect) return this.publish([]);
    let found: Diagnostic[];
    try {
      found = await findGrammar(state.doc, syntaxTree(state), view.visibleRanges, (texts) => lintParagraphs(dialect, texts), {
        ignored: ignoredLints(),
        onIgnore: ignoreLint,
      });
    } catch (e) {
      console.warn(`Grammar check unavailable: ${e}`);
      found = [];
    }
    if (run !== this.run || view.state.doc !== state.doc) return;
    this.publish(found);
  }

  private publish(found: Diagnostic[]) {
    const spec = publishSpec(this.view.state, GRAMMAR_SOURCE, found);
    if (spec) this.view.dispatch(spec);
  }

  destroy() {
    clearTimeout(this.timer);
    this.run++;
    live.delete(this);
  }
}

const theme = EditorView.baseTheme({
  ".cm-lintRange.pf-grammar": {
    backgroundImage: "none",
    textDecoration: "underline wavy color-mix(in srgb, #3b82f6 80%, transparent)",
    textDecorationThickness: "1px",
    textUnderlineOffset: "3px",
  },
});

/** Offline grammar check of the English prose in a Markdown part (Harper), reported as lint diagnostics. */
export const grammarCheck: Extension = [
  ViewPlugin.fromClass(GrammarPlugin),
  backgroundDiagnostics({ source: GRAMMAR_SOURCE, yieldTo: SPELLING_SOURCE }),
  theme,
];
