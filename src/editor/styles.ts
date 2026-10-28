import type { Completion } from "@codemirror/autocomplete";
import { ChangeSet, EditorSelection, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { Style } from "@/lib/api";
import { BUILTIN_STYLES, projectStyles } from "@/lib/styles";
import { updateMeta } from "@/session";
import { store } from "@/store";

export interface StyleEdit {
  /** In the coordinates of the document before the edit, sorted and not overlapping. */
  changes: { from: number; to: number; insert: string }[];
  /** In the coordinates of the document after the edit. */
  selection: { anchor: number; head: number };
}

const PLACEHOLDER = "text";

/** The edit with `from`..`to` mapped through it, staying inside any inserted brackets or fences. */
function edit(doc: Text, changes: StyleEdit["changes"], from: number, to: number): StyleEdit {
  const set = ChangeSet.of(changes, doc.length);
  return { changes, selection: { anchor: set.mapPos(from, 1), head: set.mapPos(to, -1) } };
}

/** The whitespace-separated tokens of an attribute block (`#id .a .b key=v`), with offsets. */
function tokens(attrs: string): { text: string; at: number }[] {
  return [...attrs.matchAll(/\S+/g)].map((m) => ({ text: m[0], at: m.index! }));
}

/** Deletes the `.name` token at `attrFrom + token.at` with one neighbouring run of spaces. */
function removeClassToken(attrs: string, attrFrom: number, name: string): StyleEdit["changes"] {
  const all = tokens(attrs);
  const i = all.findIndex((t) => t.text === `.${name}`);
  const token = all[i];
  const from = i > 0 ? all[i - 1].at + all[i - 1].text.length : token.at;
  const to = i > 0 ? token.at + token.text.length : (all[i + 1]?.at ?? token.at + token.text.length);
  return [{ from: attrFrom + from, to: attrFrom + to, insert: "" }];
}

const SPAN = /\[([^[\]\n]*)\]\{([^{}\n]*)\}/g;

/**
 * Applies the character style `name` to `from`..`to` as `[text]{.name}`, or removes it when that
 * range already is (or lies inside) text with the style. Only the brackets and the class change.
 */
export function toggleCharacterStyle(doc: Text, from: number, to: number, name: string): StyleEdit {
  const line = doc.lineAt(from);
  for (const m of line.text.matchAll(SPAN)) {
    const open = line.from + m.index!;
    const innerFrom = open + 1;
    const innerTo = innerFrom + m[1].length;
    const attrFrom = innerTo + 2;
    const end = attrFrom + m[2].length + 1;
    const exact = (from === innerFrom && to === innerTo) || (from === open && to === end);
    const inside = from >= innerFrom && to <= innerTo;
    if (!exact && !inside) continue;
    const classes = tokens(m[2]).map((t) => t.text);
    if (classes.includes(`.${name}`)) {
      if (classes.length === 1) {
        const changes = [
          { from: open, to: innerFrom, insert: "" },
          { from: innerTo, to: end, insert: "" },
        ];
        return exact ? edit(doc, changes, innerFrom, innerTo) : edit(doc, changes, from, to);
      }
      return edit(doc, removeClassToken(m[2], attrFrom, name), from, to);
    }
    if (exact) {
      const at = attrFrom + m[2].trimEnd().length;
      return edit(doc, [{ from: at, to: at, insert: classes.length ? ` .${name}` : `.${name}` }], from, to);
    }
  }
  if (from === to) {
    const insert = `[${PLACEHOLDER}]{.${name}}`;
    return { changes: [{ from, to, insert }], selection: { anchor: from + 1, head: from + 1 + PLACEHOLDER.length } };
  }
  return edit(
    doc,
    [
      { from, to: from, insert: "[" },
      { from: to, to, insert: `]{.${name}}` },
    ],
    from,
    to,
  );
}

interface Fence {
  /** Classes of an opening fence; null for a closing one. */
  classes: string[] | null;
  /** The attribute text and its offset in the line, for opening fences with `{…}`. */
  attrs?: { text: string; at: number };
}

function fence(text: string): Fence | null {
  const m = /^(:{3,})\s*(.*?)\s*$/.exec(text);
  if (!m) return null;
  const rest = m[2].replace(/\s*:+$/, "");
  if (!rest) return { classes: null };
  const braces = /^\{([^{}]*)\}$/.exec(rest);
  if (braces) {
    const at = text.indexOf("{") + 1;
    const classes = tokens(braces[1]).filter((t) => t.text.startsWith(".")).map((t) => t.text.slice(1));
    return { classes, attrs: { text: braces[1], at } };
  }
  return /^[\w-]+$/.test(rest) ? { classes: [rest] } : null;
}

/** The fenced div around lines `first`..`last` whose opening fence has `name`, as line numbers. */
function enclosingDiv(doc: Text, first: number, last: number, name: string): { open: number; close: number } | null {
  let depth = 0;
  for (let n = first; n >= 1; n--) {
    const f = fence(doc.line(n).text);
    if (!f) continue;
    if (f.classes === null) {
      if (n !== first) depth++;
      continue;
    }
    if (depth > 0) {
      depth--;
      continue;
    }
    if (!f.classes.includes(name)) continue;
    let inner = 0;
    for (let m = n + 1; m <= doc.lines; m++) {
      const g = fence(doc.line(m).text);
      if (!g) continue;
      if (g.classes !== null) inner++;
      else if (inner > 0) inner--;
      else return m >= last ? { open: n, close: m } : null;
    }
    return null;
  }
  return null;
}

const blank = (doc: Text, n: number) => doc.line(n).text.trim() === "";

/**
 * Wraps the paragraphs touched by `from`..`to` in `::: {.name}` … `:::`, or removes the style
 * from the fenced div around them that has it. Only the fence lines (or the class) change.
 */
export function toggleParagraphStyle(doc: Text, from: number, to: number, name: string): StyleEdit {
  const first = doc.lineAt(from).number;
  const last = doc.lineAt(to).number;
  const div = enclosingDiv(doc, first, last, name);
  if (div) {
    const open = doc.line(div.open);
    const f = fence(open.text)!;
    const onlyClass = f.classes!.length === 1 && (!f.attrs || tokens(f.attrs.text).length === 1);
    if (!onlyClass) return edit(doc, removeClassToken(f.attrs!.text, open.from + f.attrs!.at, name), from, to);
    const close = doc.line(div.close);
    const lastLine = div.close === doc.lines;
    if (div.close === div.open + 1) {
      return edit(doc, [{ from: lastLine ? Math.max(0, open.from - 1) : open.from, to: lastLine ? close.to : close.to + 1, insert: "" }], from, to);
    }
    const changes = [
      { from: open.from, to: open.to + 1, insert: "" },
      { from: lastLine ? close.from - 1 : close.from, to: lastLine ? close.to : close.to + 1, insert: "" },
    ];
    return edit(doc, changes, Math.max(from, open.to + 1), Math.min(to, close.from - 1));
  }
  if (first === last && blank(doc, first)) {
    const line = doc.line(first);
    const insert = `::: {.${name}}\n${PLACEHOLDER}\n:::`;
    const anchor = line.from + insert.indexOf(PLACEHOLDER);
    return { changes: [{ from: line.from, to: line.to, insert }], selection: { anchor, head: anchor + PLACEHOLDER.length } };
  }
  const bound = (n: number) => blank(doc, n) || fence(doc.line(n).text) !== null;
  let start = first;
  while (bound(start) && start < last) start++;
  let end = last;
  while (bound(end) && end > start) end--;
  while (start > 1 && !bound(start - 1)) start--;
  while (end < doc.lines && !bound(end + 1)) end++;
  const opener = doc.line(start).from;
  const closer = doc.line(end).to;
  return edit(
    doc,
    [
      { from: opener, to: opener, insert: `::: {.${name}}\n` },
      { from: closer, to: closer, insert: "\n:::" },
    ],
    from,
    to,
  );
}

function toggle(doc: Text, from: number, to: number, style: Style): StyleEdit {
  return (style.kind === "paragraph" ? toggleParagraphStyle : toggleCharacterStyle)(doc, from, to, style.name);
}

/** Adds a built-in style to the project the first time it is used. */
export function addStyleToProject(style: Style) {
  const styles = projectStyles(store.get().meta);
  if (styles.some((s) => s.name === style.name)) return;
  updateMeta({ styles: [...styles, { name: style.name, kind: style.kind, latex: style.latex }] });
}

/** Toggles `style` on the selection: every range for a character style, the main one for a paragraph style. */
export function applyStyle(view: EditorView, style: Style): boolean {
  addStyleToProject(style);
  const { state } = view;
  const ranges = style.kind === "paragraph" ? [state.selection.main] : state.selection.ranges;
  const tr = state.changeByRange((range) => {
    if (!ranges.includes(range)) return { range };
    const { changes, selection } = toggle(state.doc, range.from, range.to, style);
    return { changes, range: EditorSelection.range(selection.anchor, selection.head) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
  view.focus();
  return true;
}

/** The project's styles, then the built-ins it has not added yet. */
export function availableStyles(): Style[] {
  const own = projectStyles(store.get().meta);
  return [...own, ...BUILTIN_STYLES.filter((b) => !own.some((s) => s.name === b.name))];
}

/** `/style-<name>` entries of the line-start slash commands. */
export function styleSlashCommands(): Completion[] {
  return availableStyles().map((style) => ({
    label: `/style-${style.name}`,
    displayLabel: `/style ${style.name}`,
    detail: style.kind === "paragraph" ? "Paragraph style" : "Character style",
    type: "keyword",
    apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
      view.dispatch({ changes: { from, to }, selection: { anchor: from } });
      applyStyle(view, style);
    },
  }));
}
