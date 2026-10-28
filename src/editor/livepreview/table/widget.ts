import { isolateHistory, redo, undo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { labels } from "@/lib/outline";
import { allText } from "@/lib/parts";
import { refName } from "@/lib/refnames";
import { labelRef, store } from "@/store";
import {
  captionId,
  formatCaption,
  formatTableBlock,
  hasHeader,
  insertColumn,
  insertRow,
  isCaptionStart,
  lineChanges,
  parseCaption,
  parseTableBlock,
  removeColumn,
  removeRow,
  setAlign,
  setCell,
  tableLabel,
  toggleHeader,
  uniqueTableLabel,
  withCaptionId,
  type Align,
  type Caption,
  type PipeTable,
  type TableBlock,
} from "./pipe";
import { convertSimpleTable } from "./simple";

/** The top-level syntax node starting at `pos`, if it is a `name`. */
export function topNodeAt(state: EditorState, pos: number, name: string): SyntaxNode | null {
  const node = syntaxTree(state).topNode.childAfter(pos);
  return node && node.from === pos && node.name === name ? node : null;
}

export interface CaptionSite {
  from: number;
  to: number;
  caption: Caption;
}

function captionParagraph(state: EditorState, node: SyntaxNode | null): CaptionSite | null {
  if (node?.name !== "Paragraph") return null;
  const text = state.sliceDoc(node.from, node.to);
  const caption = isCaptionStart(text) ? parseCaption(text) : null;
  return caption ? { from: node.from, to: node.to, caption } : null;
}

/** Whether `node` is a table that takes the caption paragraph after it: it has none before or inside. */
function takesCaptionAfter(state: EditorState, node: SyntaxNode | null): boolean {
  if (node?.name !== "Table") return false;
  return !parseTableBlock(state.sliceDoc(node.from, node.to))?.caption && !captionParagraph(state, node.prevSibling);
}

/** The caption Pandoc gives a table: on its own lines, else the paragraph before it, else the one after. */
export function tableCaption(state: EditorState, node: SyntaxNode, block: TableBlock | null): CaptionSite | null {
  if (block?.caption) return { from: node.from + block.captionAt, to: node.to, caption: block.caption };
  const before = captionParagraph(state, node.prevSibling);
  if (before && !takesCaptionAfter(state, node.prevSibling!.prevSibling)) return before;
  return captionParagraph(state, node.nextSibling);
}

/** Whether a caption paragraph belongs to the table before or after it. */
export function isTableCaption(state: EditorState, node: SyntaxNode): boolean {
  return [node.prevSibling, node.nextSibling].some(
    (table) =>
      table?.name === "Table" &&
      tableCaption(state, table, parseTableBlock(state.sliceDoc(table.from, table.to)))?.from === node.from,
  );
}

/** "Table 2.1:" once a compile numbered the label, "Table:" before. */
export function captionName(caption: Caption | null): string {
  const name = refName("tbl", store.get().meta?.language);
  const number = caption ? labelRef(captionId(caption))?.number : undefined;
  return number ? `${name} ${number}:` : `${name}:`;
}

function takenLabels(state: EditorState): Set<string> {
  return new Set([...labels(allText(store.get().parts ?? [])).tbl, ...labels(state.doc.toString()).tbl]);
}

/**
 * Replaces `before` (the document text at `base`) by `after` with whole-line changes, as one undo
 * step. The cursor is first parked on the line after `end`, outside the widget, so that undo
 * restores it there instead of scrolling back to wherever it was.
 */
function writeLines(view: EditorView, base: number, before: string, after: string, end: number): boolean {
  const changes = lineChanges(before, after).map((c) => ({ from: base + c.from, to: base + c.to, insert: c.insert }));
  if (!changes.length) return false;
  const park = end + 1;
  const sel = view.state.selection.main;
  if (park <= view.state.doc.length && (sel.anchor !== park || sel.head !== park)) {
    view.dispatch({ selection: { anchor: park }, userEvent: "select" });
  }
  view.dispatch({ changes, userEvent: "input.table", annotations: isolateHistory.of("full") });
  return true;
}

function posOf(view: EditorView, dom: HTMLElement): number | null {
  try {
    return view.posAtDOM(dom);
  } catch {
    return null;
  }
}

/** Focuses the element with `key` in the widget (matched by `selector`) whose source starts at `from`. */
function focusIn(view: EditorView, selector: string, from: number, key: string, select = true) {
  for (const dom of view.contentDOM.querySelectorAll<HTMLElement>(selector)) {
    if (posOf(view, dom) !== from) continue;
    const target = dom.querySelector<HTMLElement>(`[data-key="${key}"]`);
    if (!target) return;
    target.focus();
    if (!(target instanceof HTMLInputElement)) selectContents(target, !select);
    else if (select) target.select();
    return;
  }
}

/** Moves the editor's cursor to the line after `to`, out of the widget. */
function leave(view: EditorView, to: number) {
  view.focus();
  view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, to + 1) }, userEvent: "select" });
}

function keyOf(el: EventTarget | null, root: HTMLElement): string | undefined {
  return el instanceof HTMLElement && root.contains(el) ? el.dataset.key : undefined;
}

/** Set while a widget rebuilds its DOM, so the removed fields do not commit on blur. */
let rendering = false;

function rebuild(root: HTMLElement, build: () => Node[]) {
  const key = keyOf(root.ownerDocument.activeElement, root);
  rendering = true;
  try {
    root.replaceChildren(...build());
  } finally {
    rendering = false;
  }
  if (key) root.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus();
}

function button(label: string, title: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  b.setAttribute("aria-label", title);
  // Keeps the focus, and the text not yet committed, in the cell the button acts on.
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => {
    e.preventDefault();
    run();
  });
  return b;
}

function selectContents(el: HTMLElement, collapse = false) {
  const sel = el.ownerDocument.getSelection();
  if (!sel) return;
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  if (collapse) range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function editable(el: HTMLElement, key: string, label: string) {
  el.contentEditable = "plaintext-only";
  el.dataset.key = key;
  el.setAttribute("role", "textbox");
  el.setAttribute("aria-label", label);
  // The browser's select-all would select the whole editor, and typing would replace the document.
  el.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectContents(el);
    }
  });
}

const oneLine = (text: string) => text.replace(/\s*\r?\n\s*/g, " ");

interface CaptionHost {
  /** The caption in the current document; the widget may have been built for an older one. */
  site(): CaptionSite | null;
  /** Focuses a field of the host after a write re-rendered it. */
  focus(key: string, select?: boolean): void;
}

/** The caption text and `#tbl:` label of a table, each written back when it is committed. */
function captionFields(view: EditorView, caption: Caption, name: string, host: CaptionHost): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "pf-table-caption";
  const title = dom.appendChild(document.createElement("span"));
  title.className = "pf-table-caption-name";
  title.textContent = name;
  const text = dom.appendChild(document.createElement("span"));
  text.className = "pf-table-caption-text";
  editable(text, "caption", "Table caption");
  const shown = oneLine(caption.text);
  text.textContent = shown;

  const label = dom.appendChild(document.createElement("label"));
  label.className = "pf-table-label";
  label.appendChild(document.createElement("span")).textContent = "#tbl:";
  const input = label.appendChild(document.createElement("input"));
  input.dataset.key = "label";
  input.setAttribute("aria-label", "Table label");
  input.spellcheck = false;
  const id = captionId(caption);
  const typed = id.replace(/^tbl:/, "");
  input.value = typed;
  input.size = Math.max(6, typed.length + 1);

  const write = (next: (c: Caption) => Caption) => {
    const at = host.site();
    if (at) writeLines(view, at.from, view.state.sliceDoc(at.from, at.to), formatCaption(next(at.caption)), at.to);
  };
  const commitText = () => {
    const value = oneLine(text.textContent ?? "").trim();
    if (value !== shown.trim()) write((c) => ({ ...c, text: value }));
  };
  const commitLabel = (): boolean => {
    const value = tableLabel(input.value);
    if (value === id) return true;
    if (value && takenLabels(view.state).has(value)) {
      input.setAttribute("aria-invalid", "true");
      input.title = `${value} is already used`;
      return false;
    }
    write((c) => withCaptionId(c, value));
    return true;
  };
  const exit = () => {
    const at = host.site();
    if (at) leave(view, at.to);
  };
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitText();
      host.focus("label");
    } else if (e.key === "Escape") {
      e.preventDefault();
      text.textContent = shown;
      exit();
    }
  });
  input.addEventListener("input", () => {
    input.removeAttribute("aria-invalid");
    input.title = "";
    input.size = Math.max(6, input.value.length + 1);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (commitLabel()) exit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.value = typed;
      exit();
    }
  });
  dom.addEventListener("focusout", (e) => {
    if (rendering) return;
    const next = keyOf(e.relatedTarget, dom);
    const doc = view.state.doc;
    if (e.target === text) commitText();
    else if (e.target === input) commitLabel();
    // A write re-rendered the fields, dropping the focus the click was giving.
    if (next && view.state.doc !== doc) host.focus(next, false);
  });
  return dom;
}

interface Cell {
  /** -1 for the header row. */
  row: number;
  col: number;
}

const cellKey = (c: Cell) => `cell:${c.row}:${c.col}`;

function cellOf(key: string | undefined): Cell | null {
  if (!key?.startsWith("cell:")) return null;
  const [, row, col] = key.split(":");
  return { row: Number(row), col: Number(col) };
}

function clampCell(t: PipeTable, c: Cell): Cell {
  return { row: Math.max(-1, Math.min(c.row, t.rows.length - 1)), col: Math.max(0, Math.min(c.col, t.header.length - 1)) };
}

const icon = (bars: [number, number][]) =>
  `<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">${bars
    .map(([x, w], i) => `<rect x="${x}" y="${2.5 + i * 3.5}" width="${w}" height="1.6" rx="0.8" fill="currentColor"/>`)
    .join("")}</svg>`;

const ALIGNS: [Align, string, string][] = [
  ["left", "Align left", icon([[1, 12], [1, 7], [1, 10]])],
  ["center", "Align center", icon([[1, 12], [3.5, 7], [2, 10]])],
  ["right", "Align right", icon([[1, 12], [6, 7], [3, 10]])],
];

type Edit = (t: PipeTable, at: Cell) => { table: PipeTable; focus?: Cell };

/** The grid standing in for a pipe table in Writing mode; every edit rewrites only the table's lines. */
export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly block: TableBlock,
    readonly name: string,
    /** Whether a paragraph next to the table captions it; otherwise the grid offers to add one. */
    readonly captioned: boolean,
  ) {
    super();
  }

  eq(other: TableWidget) {
    return other.source === this.source && other.name === this.name && other.captioned === this.captioned;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "pf-table";
    dom.contentEditable = "false";
    this.updateDOM(dom, view);
    return dom;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    rebuild(dom, () => {
      const parts: Node[] = [this.toolbar(view, dom), this.grid(view, dom)];
      if (this.block.caption) {
        parts.push(
          captionFields(view, this.block.caption, this.name, {
            site: () => this.site(view, dom),
            focus: (key, select) => this.focus(view, dom, key, select),
          }),
        );
      }
      return parts;
    });
    return true;
  }

  ignoreEvent() {
    return true;
  }

  get estimatedHeight() {
    return (this.block.table.rows.length + 1) * 30 + 40;
  }

  /** The table's node in the current document. */
  private node(view: EditorView, dom: HTMLElement): SyntaxNode | null {
    const pos = posOf(view, dom);
    return pos === null ? null : topNodeAt(view.state, pos, "Table");
  }

  private site(view: EditorView, dom: HTMLElement): CaptionSite | null {
    const node = this.node(view, dom);
    return node ? tableCaption(view.state, node, parseTableBlock(view.state.sliceDoc(node.from, node.to))) : null;
  }

  private focus(view: EditorView, dom: HTMLElement, key: string, select = true) {
    const pos = posOf(view, dom);
    if (pos !== null) focusIn(view, ".pf-table", pos, key, select);
  }

  /** The cell the toolbar acts on: the last one focused. */
  private current(dom: HTMLElement): Cell {
    return cellOf(dom.dataset.cell) ?? { row: Number.MAX_SAFE_INTEGER, col: Number.MAX_SAFE_INTEGER };
  }

  /**
   * Applies `edit` to the table as the document has it now (an edit returning the same table writes
   * nothing), then focuses the cell it names; with `restore`, only when the write re-rendered the grid.
   */
  private apply(view: EditorView, dom: HTMLElement, at: Cell, edit: Edit, select = true, restore = false) {
    const node = this.node(view, dom);
    if (!node) return;
    const text = view.state.sliceDoc(node.from, node.to);
    const block = parseTableBlock(text);
    if (!block) return;
    const { table, focus } = edit(block.table, clampCell(block.table, at));
    const wrote = table !== block.table && writeLines(view, node.from, text, formatTableBlock(table, block, text), node.to);
    if (focus && (wrote || !restore)) focusIn(view, ".pf-table", node.from, cellKey(clampCell(table, focus)), select);
  }

  /** Writes the cell's text if it differs from the document's, then focuses `focus`. */
  private commit(view: EditorView, dom: HTMLElement, el: HTMLElement, focus?: Cell, select = true, restore = false) {
    const cell = cellOf(el.dataset.key);
    if (!cell) return;
    const value = el.textContent ?? "";
    const edit: Edit = (t) => {
      const next = setCell(t, cell.row, cell.col, value);
      const was = cell.row < 0 ? t.header[cell.col] : t.rows[cell.row]?.[cell.col];
      const now = cell.row < 0 ? next.header[cell.col] : next.rows[cell.row]?.[cell.col];
      return { table: was === now ? t : next, focus };
    };
    this.apply(view, dom, cell, edit, select, restore);
  }

  /** Commits the focused cell, then applies `edit` at the cell the toolbar acts on. */
  private act(view: EditorView, dom: HTMLElement, edit: Edit) {
    const focused = dom.ownerDocument.activeElement;
    if (focused instanceof HTMLElement && cellOf(keyOf(focused, dom))) this.commit(view, dom, focused);
    this.apply(view, dom, this.current(dom), edit);
  }

  private toolbar(view: EditorView, dom: HTMLElement): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "pf-table-toolbar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Table");
    const group = (...items: HTMLElement[]) => {
      const g = bar.appendChild(document.createElement("span"));
      g.className = "pf-table-group";
      g.append(...items);
    };
    const { table } = this.block;
    group(
      button("+ Row", "Add row below", () =>
        this.act(view, dom, (t, at) => ({ table: insertRow(t, at.row + 1), focus: { row: at.row + 1, col: at.col } })),
      ),
      button("+ Column", "Add column right", () =>
        this.act(view, dom, (t, at) => ({ table: insertColumn(t, at.col + 1), focus: { row: at.row, col: at.col + 1 } })),
      ),
      button("− Row", "Delete row", () =>
        this.act(view, dom, (t, at) => ({ table: at.row < 0 ? t : removeRow(t, at.row), focus: at })),
      ),
      button("− Column", "Delete column", () => this.act(view, dom, (t, at) => ({ table: removeColumn(t, at.col), focus: at }))),
    );
    const col = clampCell(table, this.current(dom)).col;
    group(
      ...ALIGNS.map(([align, title, svg]) => {
        const b = button("", title, () =>
          this.act(view, dom, (t, at) => ({ table: setAlign(t, at.col, t.align[at.col] === align ? "" : align), focus: at })),
        );
        b.innerHTML = svg;
        b.dataset.align = align;
        b.setAttribute("aria-pressed", String(table.align[col] === align));
        return b;
      }),
    );
    const header = button("Header row", "Header row", () => this.act(view, dom, (t, at) => ({ table: toggleHeader(t), focus: at })));
    header.setAttribute("aria-pressed", String(hasHeader(table)));
    const extra = [header];
    if (!this.block.caption && !this.captioned) extra.push(button("+ Caption", "Add caption", () => this.addCaption(view, dom)));
    group(...extra);
    const source = button("Edit as text", "Edit as text", () => {
      const node = this.node(view, dom);
      if (!node) return;
      view.focus();
      view.dispatch({ selection: { anchor: node.from }, scrollIntoView: true, userEvent: "select" });
    });
    source.classList.add("pf-table-source");
    bar.appendChild(source);
    return bar;
  }

  private addCaption(view: EditorView, dom: HTMLElement) {
    const node = this.node(view, dom);
    if (!node || tableCaption(view.state, node, parseTableBlock(view.state.sliceDoc(node.from, node.to)))) return;
    const insert = `\n\n: Caption {#${uniqueTableLabel(takenLabels(view.state))}}`;
    writeLines(view, node.to, "", insert, node.to);
    focusIn(view, ".pf-table-caption-block", node.to + 2, "caption");
  }

  private grid(view: EditorView, dom: HTMLElement): HTMLElement {
    const { table } = this.block;
    const grid = document.createElement("table");
    grid.className = "pf-table-grid";
    if (!hasHeader(table)) grid.classList.add("pf-table-headless");
    const row = (parent: HTMLElement, cells: string[], r: number, tag: "th" | "td") => {
      const tr = parent.appendChild(document.createElement("tr"));
      cells.forEach((text, c) => {
        const cell = tr.appendChild(document.createElement(tag));
        editable(cell, cellKey({ row: r, col: c }), r < 0 ? `Header, column ${c + 1}` : `Row ${r + 1}, column ${c + 1}`);
        cell.textContent = text;
        if (table.align[c]) cell.style.textAlign = table.align[c];
      });
    };
    row(grid.createTHead(), table.header, -1, "th");
    const body = grid.createTBody();
    table.rows.forEach((cells, r) => row(body, cells, r, "td"));

    const width = table.header.length;
    const step = (at: Cell, by: number): Cell | null => {
      const index = (at.row + 1) * width + at.col + by;
      if (index < 0 || index >= (table.rows.length + 1) * width) return null;
      return { row: Math.floor(index / width) - 1, col: index % width };
    };
    grid.addEventListener("focusin", (e) => {
      const at = cellOf(keyOf(e.target, grid));
      if (!at) return;
      dom.dataset.cell = cellKey(at);
      for (const b of dom.querySelectorAll<HTMLElement>(".pf-table-toolbar [data-align]")) {
        b.setAttribute("aria-pressed", String(table.align[at.col] === b.dataset.align));
      }
    });
    grid.addEventListener("focusout", (e) => {
      if (rendering || !(e.target instanceof HTMLElement)) return;
      // Into another cell: that cell gets the focus back after the re-render.
      this.commit(view, dom, e.target, cellOf(keyOf(e.relatedTarget, grid)) ?? undefined, false, true);
    });
    grid.addEventListener("keydown", (e) => {
      const el = e.target as HTMLElement;
      const at = cellOf(keyOf(el, grid));
      if (!at) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (e.key === "Tab") {
        e.preventDefault();
        const next = step(at, e.shiftKey ? -1 : 1);
        if (next) this.commit(view, dom, el, next);
        else if (!e.shiftKey) {
          this.commit(view, dom, el);
          this.apply(view, dom, at, (t) => ({ table: insertRow(t, t.rows.length), focus: { row: t.rows.length, col: 0 } }));
        }
      } else if (e.key === "Enter" && mod) {
        e.preventDefault();
        this.commit(view, dom, el);
        this.apply(view, dom, at, (t, c) => ({ table: insertRow(t, c.row + 1), focus: { row: c.row + 1, col: c.col } }));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const next = { row: at.row + (e.shiftKey ? -1 : 1), col: at.col };
        if (next.row >= -1 && next.row < table.rows.length) return this.commit(view, dom, el, next);
        this.commit(view, dom, el);
        const node = this.node(view, dom);
        if (node && !e.shiftKey) leave(view, node.to);
      } else if (e.key === "Escape") {
        e.preventDefault();
        el.textContent = at.row < 0 ? table.header[at.col] : table.rows[at.row][at.col];
        const node = this.node(view, dom);
        if (node) leave(view, node.to);
      } else if (mod && !e.altKey && (key === "z" || key === "y")) {
        e.preventDefault();
        this.commit(view, dom, el);
        (key === "y" || e.shiftKey ? redo : undo)(view);
        this.focus(view, dom, cellKey(at), false);
      }
    });
    return grid;
  }
}

/** A caption paragraph next to its table: the caption's text and label as fields. */
export class CaptionWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly caption: Caption,
    readonly name: string,
  ) {
    super();
  }

  eq(other: CaptionWidget) {
    return other.source === this.source && other.name === this.name;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "pf-table-caption-block";
    dom.contentEditable = "false";
    this.updateDOM(dom, view);
    return dom;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    rebuild(dom, () => [
      captionFields(view, this.caption, this.name, {
        site: () => {
          const pos = posOf(view, dom);
          const node = pos === null ? null : topNodeAt(view.state, pos, "Paragraph");
          return node ? captionParagraph(view.state, node) : null;
        },
        focus: (key, select) => {
          const pos = posOf(view, dom);
          if (pos !== null) focusIn(view, ".pf-table-caption-block", pos, key, select);
        },
      }),
    ]);
    return true;
  }

  ignoreEvent() {
    return true;
  }

  get estimatedHeight() {
    return 28;
  }
}

/** The pipe table for the simple table whose dashed line is line `n`, with the range it replaces. */
export function simpleTableAt(state: EditorState, n: number): { from: number; to: number; text: string } | null {
  const doc = state.doc;
  const first = Math.max(1, n - 2);
  const lines: string[] = [];
  for (let i = first; i <= doc.lines && i < n + 500; i++) {
    const text = doc.line(i).text;
    if (i > n && !text.trim()) break;
    lines.push(text);
  }
  const conversion = convertSimpleTable(lines, n - first);
  if (!conversion) return null;
  return { from: doc.line(first + conversion.first).from, to: doc.line(first + conversion.last).to, text: conversion.text };
}

/** After the dashed line of a simple table that converts losslessly: a button that converts it. */
export class ConvertWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("span");
    dom.className = "pf-table-convert";
    dom.appendChild(
      button("Convert to pipe table", "Convert to pipe table", () => {
        const pos = posOf(view, dom);
        const at = pos === null ? null : simpleTableAt(view.state, view.state.doc.lineAt(pos).number);
        if (!at) return;
        writeLines(view, at.from, view.state.sliceDoc(at.from, at.to), at.text, at.to);
      }),
    );
    return dom;
  }

  ignoreEvent() {
    return true;
  }
}
