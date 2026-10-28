// Comments in the editor: the commented text is highlighted in both modes (hover shows the
// comment), Writing mode hides the brackets and shows a marker for the attributes, and
// Mod-Alt-C (or the toolbar button) opens a box that adds a comment to the selection, or edits
// the one under the cursor. Only the comments around the viewport are parsed.

import { StateEffect, StateField, type ChangeDesc, type EditorState, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  showTooltip,
  type Command,
  type DecorationSet,
  type Tooltip,
  type TooltipView,
  type ViewUpdate,
} from "@codemirror/view";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { CommentBox } from "@/components/CommentBox";
import { paragraphsAround, untracked } from "@/editor/changes/track";
import { notify } from "@/components/Toaster";
import { previewDecorations, registerInlineWidget } from "@/editor/livepreview";
import { activeSpans, touchesActive } from "@/editor/livepreview/syntax";
import { setCommentAuthor, store } from "@/store";
import {
  COMMENT_CLASS,
  commentAt,
  commentDate,
  parseComments,
  plainExcerpt,
  removeComment,
  setCommentAttribute,
  setResolved,
  wrapComment,
  type Comment,
} from "./model";
import "./comments.css";

function commentsBetween(state: EditorState, from: number, to: number): Comment[] {
  const range = paragraphsAround(state, from, to);
  return parseComments(state.sliceDoc(range.from, range.to), range.from);
}

/** The comment whose span holds `pos`, innermost first. */
export function commentNear(state: EditorState, pos: number): Comment | null {
  return commentAt(commentsBetween(state, pos, pos), pos);
}

function describe(c: { author: string; date: string; body: string; resolved: boolean }): string {
  const who = [c.author || "Anonymous", c.date.replace("T", " ")].filter(Boolean).join(" · ");
  return `${who}${c.resolved ? " (resolved)" : ""}\n${c.body}`;
}

// The comment box --------------------------------------------------------------------------

interface BoxRequest {
  /** The passage to comment on, or the span of the comment to edit. */
  from: number;
  to: number;
  edit: boolean;
}

export const openCommentBox = StateEffect.define<BoxRequest | null>();

function boxView(view: EditorView, request: BoxRequest): TooltipView {
  const dom = document.createElement("div");
  const root = createRoot(dom);
  const comment = request.edit ? commentNear(view.state, request.from) : null;
  const finish = (changes: ReturnType<typeof wrapComment>) => {
    view.dispatch({ changes, effects: openCommentBox.of(null), userEvent: "input.comment", annotations: untracked.of(true) });
    view.focus();
  };
  root.render(
    createElement(CommentBox, {
      excerpt: plainExcerpt(comment ? comment.text : view.state.sliceDoc(request.from, request.to)),
      existing: comment ?? undefined,
      author: store.get().commentAuthor,
      onSubmit(body, author) {
        if (author !== store.get().commentAuthor) setCommentAuthor(author);
        finish(
          comment
            ? setCommentAttribute(comment, "text", body)
            : wrapComment(request.from, request.to, { author, date: commentDate(), body }),
        );
      },
      onCancel() {
        view.dispatch({ effects: openCommentBox.of(null) });
        view.focus();
      },
      onResolve: comment ? (resolved) => finish(setResolved(comment, resolved)) : undefined,
      onDelete: comment ? () => finish(removeComment(comment)) : undefined,
    }),
  );
  // Unmounting synchronously inside a React event handler that dispatched would warn.
  return { dom, destroy: () => queueMicrotask(() => root.unmount()) };
}

/** Closes on any edit of the document: the passage it was opened for may have moved. */
const commentBox = StateField.define<Tooltip | null>({
  create: () => null,
  update(tooltip, tr) {
    for (const e of tr.effects) {
      if (e.is(openCommentBox)) {
        const request = e.value;
        return request && { pos: request.to, create: (view) => boxView(view, request) };
      }
    }
    return tr.docChanged ? null : tooltip;
  },
  provide: (f) => showTooltip.from(f),
});

function openEditor(view: EditorView, c: Comment) {
  view.dispatch({ effects: openCommentBox.of({ from: c.from, to: c.textTo, edit: true }) });
}

/** Why `from`..`to` cannot become a comment: it would cut through the brackets of another one. */
function crossesComment(comments: readonly Comment[], from: number, to: number): boolean {
  return comments.some((c) => {
    const inText = from >= c.textFrom && to <= c.textTo;
    const around = from <= c.from && to >= c.to;
    const apart = to <= c.from || from >= c.to;
    return !inText && !around && !apart;
  });
}

/** Comments on the selection (or the word at the cursor); inside a comment, edits it instead. */
export const addComment: Command = (view) => {
  const { state } = view;
  const sel = state.selection.main;
  let { from, to } = sel;
  const comments = commentsBetween(state, from, to);
  if (from === to) {
    const existing = commentAt(comments, from);
    if (existing) {
      openEditor(view, existing);
      return true;
    }
    const word = state.wordAt(from);
    if (!word) {
      notify("Select the text to comment on.", "error");
      return true;
    }
    ({ from, to } = word);
  }
  const text = state.sliceDoc(from, to);
  from += text.length - text.trimStart().length;
  to -= text.length - text.trimEnd().length;
  if (from >= to || /\n[ \t]*\n/.test(text.trim())) {
    notify("A comment covers some text within one paragraph.", "error");
  } else if (crossesComment(comments, from, to)) {
    notify("The selection cuts through another comment; select inside or around it.", "error");
  } else {
    view.dispatch({ selection: { anchor: from, head: to }, effects: openCommentBox.of({ from, to, edit: false }) });
  }
  return true;
};

// Highlights and markers ---------------------------------------------------------------------

const HIDDEN = Decoration.replace({});
/** Characters parsed beyond the viewport on each side, so short scrolls need no parse. */
const MARGIN = 2000;

/** What the highlights need of a comment; positions follow the edits made after parsing it. */
type Shown = Pick<Comment, "from" | "to" | "textFrom" | "textTo" | "attrsFrom" | "author" | "date" | "body" | "resolved">;

function mapShown(c: Shown, changes: ChangeDesc): Shown {
  const map = (pos: number) => changes.mapPos(pos);
  return { ...c, from: map(c.from), to: map(c.to), textFrom: map(c.textFrom), textTo: map(c.textTo), attrsFrom: map(c.attrsFrom) };
}

function highlightDecorations(state: EditorState, comments: readonly Shown[]): DecorationSet {
  if (comments.length === 0) return Decoration.none;
  const writing = previewDecorations(state) !== null;
  const active = writing ? activeSpans(state.selection.ranges, (pos) => state.doc.lineAt(pos)) : [];
  const out: Range<Decoration>[] = [];
  for (const c of comments) {
    if (c.textFrom < c.textTo) {
      const className = c.resolved ? "pf-comment pf-comment-resolved" : "pf-comment";
      out.push(Decoration.mark({ class: className, attributes: { title: describe(c) } }).range(c.textFrom, c.textTo));
    }
    if (writing) {
      if (!touchesActive(c.from, c.textFrom, active)) out.push(HIDDEN.range(c.from, c.textFrom));
      if (!touchesActive(c.textTo, c.attrsFrom, active)) out.push(HIDDEN.range(c.textTo, c.attrsFrom));
    }
  }
  return Decoration.set(out, true);
}

/**
 * Comments parsed around the viewport: an edit re-parses only the paragraphs it touched (a
 * comment never spans paragraphs) and maps the others, a scroll past the parsed range parses the
 * new viewport.
 */
const commentHighlights = ViewPlugin.fromClass(
  class {
    covered = { from: 0, to: 0 };
    comments: Shown[] = [];
    /** The cursor's lines in Writing mode, where brackets show; "" in Source mode. */
    active = "";
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.cover(view);
      this.active = activeLines(view.state);
      this.decorations = highlightDecorations(view.state, this.comments);
    }

    private cover(view: EditorView) {
      const { from, to } = view.viewport;
      const length = view.state.doc.length;
      this.covered = paragraphsAround(view.state, Math.max(0, from - MARGIN), Math.min(length, to + MARGIN));
      this.comments = parseComments(view.state.sliceDoc(this.covered.from, this.covered.to), this.covered.from);
    }

    update(u: ViewUpdate) {
      let reparsed = false;
      if (u.docChanged) {
        let from = u.state.doc.length;
        let to = 0;
        u.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
          from = Math.min(from, fromB);
          to = Math.max(to, toB);
        });
        const region = paragraphsAround(u.state, from, to);
        const mapped = this.comments.map((c) => mapShown(c, u.changes));
        const kept = mapped.filter((c) => c.to < region.from || c.from > region.to);
        const fresh = parseComments(u.state.sliceDoc(region.from, region.to), region.from);
        reparsed = fresh.length > 0 || kept.length < mapped.length;
        this.comments = reparsed ? [...kept, ...fresh].sort((a, b) => a.from - b.from) : mapped;
        this.covered = {
          from: Math.min(u.changes.mapPos(this.covered.from, -1), region.from),
          to: Math.max(u.changes.mapPos(this.covered.to, 1), region.to),
        };
      }
      const { from, to } = u.view.viewport;
      if (u.viewportChanged && (from < this.covered.from || to > this.covered.to)) {
        this.cover(u.view);
        reparsed = true;
      }
      const active = activeLines(u.state);
      const moved = active !== this.active;
      this.active = active;
      if (!reparsed && !(moved && this.comments.length > 0)) {
        if (u.docChanged) this.decorations = this.decorations.map(u.changes);
        return;
      }
      this.decorations = highlightDecorations(u.state, this.comments);
    }
  },
  { decorations: (v) => v.decorations },
);

/** The lines whose comment brackets show: the cursor's, in Writing mode only. */
function activeLines(state: EditorState): string {
  if (previewDecorations(state) === null) return "";
  return state.selection.ranges.map((r) => `${state.doc.lineAt(r.from).number}-${state.doc.lineAt(r.to).number}`).join(",");
}

class CommentMarker extends WidgetType {
  constructor(
    readonly author: string,
    readonly date: string,
    readonly body: string,
    readonly resolved: boolean,
  ) {
    super();
  }

  eq(other: CommentMarker) {
    return other.author === this.author && other.date === this.date && other.body === this.body && other.resolved === this.resolved;
  }

  toDOM(view: EditorView) {
    const dom = document.createElement("span");
    dom.className = this.resolved ? "pf-comment-marker pf-comment-resolved" : "pf-comment-marker";
    dom.title = describe(this);
    dom.setAttribute("aria-label", `Comment by ${this.author || "Anonymous"}`);
    dom.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    dom.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const pos = view.posAtDOM(dom);
      const comment = commentsBetween(view.state, pos, pos).find((c) => c.attrsFrom === pos);
      if (comment) openEditor(view, comment);
    });
    return dom;
  }

  ignoreEvent() {
    return true;
  }
}

registerInlineWidget("attr", (token) => {
  if (!token.attrs.classes.includes(COMMENT_CLASS)) return null;
  const { author = "", date = "", text = "", resolved } = token.attrs.pairs;
  return new CommentMarker(author, date, text, resolved === "true");
});

export const comments: Extension = [commentBox, commentHighlights, keymap.of([{ key: "Mod-Alt-c", run: addComment }])];
