import {
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import type { LabelRef, Part } from "@/lib/api";
import { labels, type Labels } from "@/lib/outline";
import { allText } from "@/lib/parts";
import { refDetail, refKind, refName, referenceText } from "@/lib/refnames";
import { store } from "@/store";

let labelCache: { parts: Part[]; labels: Labels } = { parts: [], labels: labels("") };

/** Labels from every part: a reference may point into another file. */
function documentLabels(): string[] {
  const parts = store.get().parts;
  if (parts !== labelCache.parts) labelCache = { parts, labels: labels(allText(parts)) };
  return Object.values(labelCache.labels).flat();
}

/** `@` completion options for the document's labels, numbered once a compile has run. */
export function labelOptions(numbers: Record<string, LabelRef> = store.get().labels): Completion[] {
  return documentLabels().map((id) => ({ label: `@${id}`, detail: refDetail(id, numbers[id]), type: "variable" }));
}

/** `/ref` options: the label filters by `/ref <id>`, the list shows what will be inserted. */
export function pickerOptions(
  language: string | undefined,
  numbers: Record<string, LabelRef> = store.get().labels,
): Completion[] {
  return documentLabels().map((id) => ({
    label: `/ref ${id}`,
    displayLabel: `${refName(refKind(id)!, language)} @${id}`,
    detail: refDetail(id, numbers[id]),
    type: "variable",
    boost: 1,
    apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
      const line = view.state.doc.lineAt(from);
      const insert = referenceText(id, language, view.state.sliceDoc(line.from, from));
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        userEvent: "input.complete",
      });
    },
  }));
}

/** `/ref` anywhere in the text: pick a label and insert it with its localized name. */
export function crossRefCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\/ref[\w:.-]*/);
  if (!word) return null;
  if (/[\w/]/.test(context.state.sliceDoc(word.from - 1, word.from))) return null;
  return { from: word.from, options: pickerOptions(store.get().meta?.language), validFor: /^\/ref[\w:.-]*$/ };
}

/** The `/ref` entry of the line-start slash commands; it opens the reference picker. */
export const refSlashCommand: Completion = {
  label: "/ref",
  detail: "Cross reference with its name",
  type: "keyword",
  apply: (view, _completion, from, to) => {
    view.dispatch({ changes: { from, to, insert: "/ref" }, selection: { anchor: from + 4 } });
    startCompletion(view);
  },
};
