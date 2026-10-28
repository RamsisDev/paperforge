import type { Action, Diagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import type { GrammarLint, GrammarSuggestion } from "./protocol";
import { proseBlocks, proseRanges, toDocument } from "./prose";

export const GRAMMAR_SOURCE = "grammar";
const MAX_SUGGESTIONS = 4;
/** Lint kinds about style rather than correctness. */
const INFO_KINDS = new Set(["Enhancement", "Formatting", "Readability", "Redundancy", "Regionalism", "Repetition", "Style", "WordChoice"]);
/** Spelling belongs to the spell checker. */
const SKIPPED_KINDS = new Set(["Spelling"]);

export type LintTexts = (texts: string[]) => Promise<GrammarLint[][]>;

export interface GrammarOptions {
  ignored: ReadonlySet<string>;
  onIgnore: (key: string) => void;
}

/** What "Ignore" remembers: the same complaint about the same words anywhere. */
export function lintKey(lint: GrammarLint): string {
  return `${lint.kind}\n${lint.message}\n${lint.problem}`;
}

function suggestionAction(s: GrammarSuggestion): Action {
  const name = s.kind === "remove" ? "Remove" : s.kind === "insert" ? `Insert “${s.text}”` : s.text.trim() ? s.text : "Fix spacing";
  return {
    name,
    apply: (view, from, to) => {
      const changes = s.kind === "insert" ? { from: to, insert: s.text } : { from, to, insert: s.kind === "remove" ? "" : s.text };
      view.dispatch({ changes, userEvent: "input.grammar" });
    },
  };
}

export function grammarDiagnostic(lint: GrammarLint, from: number, to: number, onIgnore: (key: string) => void): Diagnostic {
  return {
    from,
    to,
    severity: INFO_KINDS.has(lint.kind) ? "info" : "warning",
    source: GRAMMAR_SOURCE,
    markClass: "pf-grammar",
    message: lint.message,
    actions: [
      ...lint.suggestions.slice(0, MAX_SUGGESTIONS).map(suggestionAction),
      { name: "Ignore", apply: () => onIgnore(lintKey(lint)) },
    ],
  };
}

/** Grammar diagnostics for the paragraphs around `ranges`, linted by `lint`. */
export async function findGrammar(
  doc: Text,
  tree: Tree,
  ranges: readonly { from: number; to: number }[],
  lint: LintTexts,
  { ignored, onIgnore }: GrammarOptions,
): Promise<Diagnostic[]> {
  const blocks = proseRanges(doc, ranges).flatMap((r) => proseBlocks(doc.sliceString(r.from, r.to), r.from, tree));
  if (!blocks.length) return [];
  const results = await lint(blocks.map((b) => b.text));
  const found: Diagnostic[] = [];
  blocks.forEach((block, i) => {
    for (const l of results[i] ?? []) {
      if (SKIPPED_KINDS.has(l.kind) || ignored.has(lintKey(l))) continue;
      const range = toDocument(block, l.start, l.end);
      if (!range || doc.sliceString(range.from, range.to) !== l.problem) continue;
      found.push(grammarDiagnostic(l, range.from, range.to, onIgnore));
    }
  });
  return found;
}
