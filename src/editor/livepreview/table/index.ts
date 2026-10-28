// Writing mode: pipe tables as editable grids, their captions as fields, and an offer to convert
// simple tables. Every edit rewrites only the table's (or caption's) own lines.

import type { Range } from "@codemirror/state";
import { Decoration, type WidgetType } from "@codemirror/view";
import { REVEAL, registerBlockWidget } from "../registry";
import { isCaptionStart, parseCaption, parseTableBlock } from "./pipe";
import { dashColumns } from "./simple";
import {
  CaptionWidget,
  ConvertWidget,
  TableWidget,
  captionName,
  isTableCaption,
  simpleTableAt,
  tableCaption,
  topNodeAt,
} from "./widget";
import "./table.css";

function blockReplace(from: number, to: number, widget: WidgetType): Range<Decoration> {
  return Decoration.replace({ widget, block: true, [REVEAL]: true }).range(from, to);
}

registerBlockWidget({
  nodes: ["Table"],
  decorate({ from, to, state }) {
    const node = topNodeAt(state, from, "Table");
    const source = state.sliceDoc(from, to);
    const block = node && parseTableBlock(source);
    if (!node || !block) return null;
    const captioned = !block.caption && tableCaption(state, node, block) !== null;
    return [blockReplace(from, to, new TableWidget(source, block, captionName(block.caption), captioned))];
  },
});

registerBlockWidget({
  nodes: ["Paragraph"],
  decorate({ from, to, state }) {
    if (!isCaptionStart(state.sliceDoc(from, from + 8))) return null;
    const node = topNodeAt(state, from, "Paragraph");
    const source = state.sliceDoc(from, to);
    const caption = parseCaption(source);
    if (!node || !caption || !isTableCaption(state, node)) return null;
    return [blockReplace(from, to, new CaptionWidget(source, caption, captionName(caption)))];
  },
});

const CONVERT = Decoration.widget({ widget: new ConvertWidget(), side: 1 });

registerBlockWidget({
  nodes: ["HorizontalRule"],
  decorate({ from, to, state }) {
    const line = state.doc.lineAt(from);
    if (!dashColumns(line.text) || !simpleTableAt(state, line.number)) return null;
    return [CONVERT.range(Math.min(line.to, to))];
  },
});
