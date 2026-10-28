import { deleteCharBackward, deleteCharForward, history, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import type { Command } from "@codemirror/view";
import { beforeEach, describe, expect, it } from "vitest";
import type { TextChange } from "@/editor/figureSyntax";
import { parseComments } from "@/editor/comments/model";
import { changeAt, changesInParts, parseChanges, resolveChanges, trackEdit, type Change } from "./model";
import { trackingFilter, untracked } from "./track";

const DATE = "2026-10-28T13:00";
const ins = (text: string, author = "Ada") => `[${text}]{.insertion author="${author}" date="${DATE}"}`;
const del = (text: string, author = "Ada") => `[${text}]{.deletion author="${author}" date="${DATE}"}`;

let tracking = true;
let blocked = 0;

function editor(doc: string, anchor = doc.length, head = anchor): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [
      history(),
      markdown(),
      trackingFilter({ settings: () => (tracking ? { author: "Ada", date: DATE } : null), onBlocked: () => blocked++ }),
    ],
  });
}

/** Runs a command that only reads `state` and calls `dispatch`, as the delete commands do. */
function run(state: EditorState, command: Command | StateCommand): EditorState {
  let next = state;
  (command as StateCommand)({ state, dispatch: (tr) => (next = tr.state) });
  return next;
}

function type(state: EditorState, text: string): EditorState {
  for (const ch of text) state = state.update({ ...state.replaceSelection(ch), userEvent: "input.type" }).state;
  return state;
}

function backspace(state: EditorState, times = 1): EditorState {
  for (let i = 0; i < times; i++) state = run(state, deleteCharBackward);
  return state;
}

function forward(state: EditorState, times = 1): EditorState {
  for (let i = 0; i < times; i++) state = run(state, deleteCharForward);
  return state;
}

const text = (state: EditorState) => state.doc.toString();
const head = (state: EditorState) => state.selection.main.head;

beforeEach(() => {
  tracking = true;
  blocked = 0;
});

describe("tracking typed text", () => {
  it("wraps typed text in an insertion and keeps typing inside it", () => {
    const state = type(editor("Hello world", 5), " big");
    expect(text(state)).toBe(`Hello${ins(" big")} world`);
    expect(head(state)).toBe("Hello[ big".length);
    expect(parseChanges(text(state)).map((c) => [c.kind, c.text, c.author, c.date])).toEqual([["insertion", " big", "Ada", DATE]]);
  });

  it("extends the author's own insertion from either side, not someone else's", () => {
    const doc = `A ${ins("new")} B`;
    const span = parseChanges(doc)[0];
    expect(text(type(editor(doc, span.to), "er"))).toBe(`A ${ins("newer")} B`);
    expect(text(type(editor(doc, span.from), "re"))).toBe(`A ${ins("renew")} B`);
    const bob = `A ${ins("new", "Bob")} B`;
    expect(text(type(editor(bob, parseChanges(bob)[0].to), "x"))).toBe(`A ${ins("new", "Bob")}${ins("x")} B`);
  });

  it("types after deleted text, never inside it", () => {
    const doc = `A ${del("old")} B`;
    const span = parseChanges(doc)[0];
    expect(text(type(editor(doc, span.textFrom + 1), "x"))).toBe(`A ${del("old")}${ins("x")} B`);
  });

  it("records closed brackets typed with closeBrackets as one insertion", () => {
    let state = editor("See it", 4);
    state = state.update({ changes: { from: 4, insert: "[]" }, selection: { anchor: 5 }, userEvent: "input.type" }).state;
    expect(text(state)).toBe(`See ${ins("[]")}it`);
    expect(text(type(state, "@k"))).toBe(`See ${ins("[@k]")}it`);
  });
});

describe("tracking deletions", () => {
  it("keeps backspaced text as one growing deletion with the cursor before it", () => {
    const state = backspace(editor("Hello world"), 2);
    expect(text(state)).toBe(`Hello wor${del("ld")}`);
    expect(head(state)).toBe("Hello wor".length);
  });

  it("keeps forward-deleted text as one deletion with the cursor after it", () => {
    const state = forward(editor("Hello world", 6), 2);
    expect(text(state)).toBe(`Hello ${del("wo")}rld`);
    expect(head(state)).toBe(`Hello ${del("wo")}`.length);
  });

  it("skips over deleted text when backspacing into it", () => {
    expect(text(backspace(editor(`A ${del("old")}`)))).toBe(`A${del(" old")}`);
    expect(text(backspace(editor(`A ${del("old", "Bob")}`)))).toBe(`A${del(" ")}${del("old", "Bob")}`);
  });

  it("really deletes inside the author's own insertion and drops it once empty", () => {
    const doc = `A ${ins("new")} B`;
    const span = parseChanges(doc)[0];
    let state = backspace(editor(doc, span.textTo));
    expect(text(state)).toBe(`A ${ins("ne")} B`);
    state = backspace(state, 2);
    expect(text(state)).toBe("A  B");
    expect(text(backspace(editor(doc, span.to)))).toBe(`A ${ins("ne")} B`);
  });

  it("turns select and type into a deletion followed by an insertion", () => {
    const state = type(editor("Hello world", 6, 11), "there");
    expect(text(state)).toBe(`Hello ${del("world")}${ins("there")}`);
    expect(head(state)).toBe(`Hello ${del("world")}[there`.length);
  });

  it("deletes a selection holding a citation and inline math whole, dropping own insertions in it", () => {
    const doc = `Cite [@knuth1984] and ${ins("new ")}$x^2$ here.`;
    const from = doc.indexOf("[@");
    const to = doc.indexOf(" here");
    const state = editor(doc, from, to).update({ changes: { from, to }, userEvent: "delete.selection" }).state;
    expect(text(state)).toBe(`Cite ${del("[@knuth1984] and $x^2$")} here.`);
  });

  it("wraps a deletion inside a comment and a comment inside a deletion", () => {
    const comment = '[some words]{.comment author="C" text="Hm"}';
    const inside = forward(editor(`A ${comment}.`, 3 + "some".length));
    expect(text(inside)).toBe(`A [some${del(" ")}words]{.comment author="C" text="Hm"}.`);
    const doc = `A ${comment} end.`;
    const around = editor(doc, 2, doc.indexOf(" end")).update({ changes: { from: 2, to: doc.indexOf(" end") }, userEvent: "delete.cut" }).state;
    expect(text(around)).toBe(`A ${del(comment)} end.`);
    expect(parseComments(text(around))).toHaveLength(1);
  });
});

describe("edits that are not tracked", () => {
  it("lets annotated, untyped and untracked-mode edits through as made", () => {
    const annotated = editor("Hello", 5).update({ changes: { from: 5, insert: "!" }, userEvent: "input.type", annotations: untracked.of(true) });
    expect(text(annotated.state)).toBe("Hello!");
    expect(text(editor("Hello", 5).update({ changes: { from: 5, insert: "!" } }).state)).toBe("Hello!");
    tracking = false;
    expect(text(type(editor("Hello", 5), "!"))).toBe("Hello!");
  });

  it("lets edits in math, code, attributes, fences and line breaks through", () => {
    const cases: [string, number, string][] = [
      ["Math $x^2$ here", "Math $x^".length, "Math $x^3"],
      ["Code `abc` here", "Code `a".length, "Code `a3"],
      ["# Title {#sec:x}", "# Title {#sec".length, "# Title {#sec3"],
      ["```\ncode\n```", "```\nco".length, "```\nco3"],
      ["::: note\ntext\n:::", ":::".length, ":::3"],
    ];
    for (const [doc, at, starts] of cases) expect(text(type(editor(doc, at), "3"))).toMatch(new RegExp(`^${starts.replace(/[$^`{}[\]]/g, "\\$&")}`));
    const state = editor("One", 3).update({ changes: { from: 3, insert: "\n" }, userEvent: "input.type" }).state;
    expect(text(state)).toBe("One\n");
  });

  it("drops a deletion that cuts through the brackets of a comment", () => {
    const doc = 'A [some words]{.comment author="C" text="Hm"} end.';
    const state = editor(doc, 0, 5).update({ changes: { from: 0, to: 5 }, userEvent: "delete.selection" }).state;
    expect(text(state)).toBe(doc);
    expect(blocked).toBe(1);
  });
});

describe("undo", () => {
  it("takes back an edit and its tracking in one step", () => {
    const typed = type(editor("Hello world", 5), "!");
    expect(text(run(typed, undo))).toBe("Hello world");
    const deleted = backspace(editor("Hello world"));
    expect(text(run(deleted, undo))).toBe("Hello world");
    const replaced = type(editor("Hello world", 6, 11), "x");
    expect(text(run(replaced, undo))).toBe("Hello world");
  });
});

describe("trackEdit", () => {
  const ctx = { author: "Ada", date: DATE, base: 10 };
  it("works in document offsets of a paragraph slice", () => {
    expect(trackEdit({ from: 15, to: 15, insert: "x", kind: "type" }, { ...ctx, text: "Hello world" })).toEqual({
      changes: [{ from: 15, to: 15, insert: ins("x") }],
      cursor: 17,
    });
    expect(trackEdit({ from: 9, to: 9, insert: "x", kind: "type" }, { ...ctx, text: "Hello" })).toBe("untracked");
  });

  it("does not open an image or a footnote by wrapping text after ! or ^", () => {
    expect(trackEdit({ from: 15, to: 15, insert: "x", kind: "type" }, { ...ctx, text: "Wow!!" })).toBe("untracked");
    expect(trackEdit({ from: 15, to: 15, insert: "x", kind: "type" }, { ...ctx, text: "2^10 " })).not.toBe("untracked");
  });
});

function apply(doc: string, changes: TextChange[]): string {
  return EditorState.create({ doc }).update({ changes }).state.doc.toString();
}

const charAt = (doc: string) => (pos: number) => doc[pos] ?? "";

function resolve(doc: string, accept: boolean, pick = (c: Change[]) => c): string {
  return apply(doc, resolveChanges(pick(parseChanges(doc)), accept, charAt(doc)));
}

describe("accept and reject", () => {
  const doc = `The ${del("old")} ${ins("new")} idea.`;

  it("accepting an insertion unwraps it, accepting a deletion removes it and a doubled space", () => {
    expect(resolve(doc, true, (c) => [c[1]])).toBe(`The ${del("old")} new idea.`);
    expect(resolve(doc, true, (c) => [c[0]])).toBe(`The ${ins("new")} idea.`);
    expect(resolve(doc, true)).toBe("The new idea.");
  });

  it("rejecting a deletion unwraps it, rejecting an insertion removes it", () => {
    expect(resolve(doc, false)).toBe("The old idea.");
    expect(resolve(`${ins("New")} start\nand ${del("end")}\n${ins("whole line")}\nnext`, false)).toBe("start\nand end\nnext");
  });

  it("resolves nested changes in one set of local deletions", () => {
    const nested = `A ${ins(`x ${del("y")} z`)} b`;
    expect(resolve(nested, true)).toBe("A x z b");
    expect(resolve(nested, false)).toBe("A b");
    const changes = resolveChanges(parseChanges(nested), false, charAt(nested));
    expect(changes).toHaveLength(1);
    expect(changes.every((c) => c.insert === "")).toBe(true);
  });

  it("finds the innermost change at a position", () => {
    const nested = `A ${ins(`x ${del("y")} z`)} b`;
    const changes = parseChanges(nested);
    expect(changeAt(changes, nested.indexOf("y"))?.kind).toBe("deletion");
    expect(changeAt(changes, nested.indexOf("x"))?.kind).toBe("insertion");
    expect(changeAt(changes, 0)).toBeNull();
  });
});

describe("changesInParts", () => {
  it("lists the changes of every part with their lines, skipping code", () => {
    const a = { file: "a.md", content: `# A\n\nOne ${ins("two")}.\n\n\`\`\`\n${del("code")}\n\`\`\`\n` };
    const b = { file: "b.md", content: `${del("Gone")} text\nand [x [y]{.insertion author="Bo"}]{.comment text="c"}\n` };
    const found = changesInParts([a, b] as never);
    expect(found.map((f) => [f.file, f.line, f.change.kind, f.change.text, f.change.author])).toEqual([
      ["a.md", 2, "insertion", "two", "Ada"],
      ["b.md", 0, "deletion", "Gone", "Ada"],
      ["b.md", 1, "insertion", "y", "Bo"],
    ]);
    expect(changesInParts([a] as never)[0]).toBe(found[0]);
  });
});

