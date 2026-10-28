import type { Completion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { insertBlock } from "@/editor/commands";
import { labels } from "@/lib/outline";
import { allText } from "@/lib/parts";
import { store } from "@/store";
import { formatTable, uniqueTableLabel } from "./pipe";

const MAX = 8;

/** An aligned pipe table with numbered column names, empty rows, and caption and label fields. */
export function tableSnippet(columns: number, rows: number, label: string): string {
  const table = formatTable({
    header: Array.from({ length: columns }, (_, i) => `Column ${i + 1}`),
    align: Array(columns).fill(""),
    rows: Array.from({ length: rows }, () => Array(columns).fill("")),
  });
  return `${table}\n\n: \${Caption} {#tbl:\${${label.replace(/^tbl:/, "")}}}`;
}

let open: { dom: HTMLElement; close: () => void } | null = null;

/** A small grid under the cursor to pick the columns and body rows of a new table. */
export function openTablePicker(view: EditorView) {
  open?.close();
  const coords = view.coordsAtPos(view.state.selection.main.head);
  const dom = document.createElement("div");
  dom.className = "pf-table-picker";
  dom.setAttribute("role", "dialog");
  dom.setAttribute("aria-label", "Insert table");
  dom.tabIndex = -1;
  dom.style.left = `${coords?.left ?? 100}px`;
  dom.style.top = `${(coords?.bottom ?? 100) + 4}px`;
  const grid = dom.appendChild(document.createElement("div"));
  grid.className = "pf-table-picker-grid";
  const size = dom.appendChild(document.createElement("div"));
  size.className = "pf-table-picker-size";
  size.setAttribute("aria-live", "polite");
  const cells: HTMLElement[] = [];
  // Row 0 of the picker is the header row; rows 1… are body rows.
  for (let r = 0; r <= MAX; r++) {
    for (let c = 1; c <= MAX; c++) {
      const cell = grid.appendChild(document.createElement("span"));
      if (r === 0) cell.classList.add("pf-header");
      cell.addEventListener("mouseenter", () => pick(c, Math.max(1, r)));
      cell.addEventListener("click", () => insert());
      cells.push(cell);
    }
  }
  let columns = 3;
  let rows = 2;
  const pick = (c: number, r: number) => {
    columns = Math.max(1, Math.min(MAX, c));
    rows = Math.max(1, Math.min(MAX, r));
    cells.forEach((cell, i) => cell.classList.toggle("pf-on", i % MAX < columns && Math.floor(i / MAX) <= rows));
    size.textContent = `${columns} × ${rows} (columns × rows, plus header)`;
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    // Set first: removing the focused picker fires its focusout, which closes again.
    closed = true;
    dom.remove();
    document.removeEventListener("pointerdown", outside, true);
    if (open?.dom === dom) open = null;
  };
  const insert = () => {
    close();
    const taken = labels(`${allText(store.get().parts)}\n\n${view.state.doc.toString()}`).tbl;
    insertBlock(view, tableSnippet(columns, rows, uniqueTableLabel(taken)));
  };
  const outside = (e: PointerEvent) => {
    if (!dom.contains(e.target as Node)) close();
  };
  dom.addEventListener("keydown", (e) => {
    const moves: Record<string, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
    if (moves[e.key]) pick(columns + moves[e.key][0], rows + moves[e.key][1]);
    else if (e.key === "Enter") insert();
    else if (e.key === "Escape") {
      close();
      view.focus();
    } else return;
    e.preventDefault();
  });
  dom.addEventListener("focusout", (e) => {
    if (!dom.contains(e.relatedTarget as Node)) close();
  });
  pick(columns, rows);
  document.body.appendChild(dom);
  document.addEventListener("pointerdown", outside, true);
  open = { dom, close };
  dom.focus();
}

/** `/table` among the slash commands: asks for the size, then inserts the table. */
export const tableSlashCommand: Completion = {
  label: "/table",
  detail: "Table with caption and label",
  type: "keyword",
  apply: (view, _completion, from, to) => {
    view.dispatch({ changes: { from, to, insert: "" }, selection: { anchor: from } });
    openTablePicker(view);
  },
};
