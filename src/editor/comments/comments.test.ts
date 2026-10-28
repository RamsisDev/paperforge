import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import type { TextChange } from "@/editor/figureSyntax";
import { parseAttributes, scanInline } from "@/editor/livepreview/syntax";
import {
  commentAt,
  commentAttributes,
  commentDate,
  commentsInParts,
  parseComments,
  plainExcerpt,
  quoteAttr,
  removeComment,
  setCommentAttribute,
  setResolved,
  wrapComment,
  type Comment,
} from "./model";

function apply(doc: string, changes: TextChange[]): string {
  return EditorState.create({ doc }).update({ changes }).state.doc.toString();
}

function only(text: string): Comment {
  const found = parseComments(text);
  expect(found).toHaveLength(1);
  return found[0];
}

const FIELDS = { author: "Ada", date: "2026-10-28T13:00", body: "Check this" };

describe("wrapComment", () => {
  it("inserts the brackets and the attributes around the selection, nothing else", () => {
    const doc = "Some anchored words here.";
    const changes = wrapComment(5, 19, FIELDS);
    expect(changes.every((c) => c.from === c.to)).toBe(true);
    const out = apply(doc, changes);
    expect(out).toBe('Some [anchored words]{.comment author="Ada" date="2026-10-28T13:00" text="Check this"} here.');
    const c = only(out);
    expect([c.text, c.author, c.date, c.body, c.resolved]).toEqual(["anchored words", "Ada", "2026-10-28T13:00", "Check this", false]);
    expect(out.slice(c.from, c.to)).toBe(out.slice(5, -6));
  });

  it("escapes quotes and backslashes, and flattens line breaks, in a way Pandoc reads back", () => {
    const body = 'Say "hi" to C:\\temp {x}\nand  more';
    expect(quoteAttr(body)).toBe('"Say \\"hi\\" to C:\\\\temp {x} and  more"');
    const out = apply("word", wrapComment(0, 4, { ...FIELDS, author: 'A "B"', body }));
    const c = only(out);
    expect(c.body).toBe('Say "hi" to C:\\temp {x} and  more');
    expect(c.author).toBe('A "B"');
    // The Writing-mode scanner reads the same values, and the whole attribute block.
    expect(parseAttributes(out.slice(c.attrsFrom + 1, c.attrsTo - 1)).pairs.text).toBe(c.body);
    const attr = scanInline(out).find((t) => t.kind === "attr");
    expect(attr && [attr.from, attr.to]).toEqual([c.attrsFrom, c.attrsTo]);
  });

  it("dates comments to the minute in local time", () => {
    expect(commentDate(new Date(2026, 9, 28, 9, 5, 59))).toBe("2026-10-28T09:05");
    expect(commentAttributes(FIELDS)).toBe('{.comment author="Ada" date="2026-10-28T13:00" text="Check this"}');
  });
});

describe("attribute edits", () => {
  const doc = 'A [b]{.comment author="Ada" date="2026-10-28T13:00" text="Old \\"body\\""} c.';

  it("replaces only the value of an attribute", () => {
    const c = only(doc);
    const changes = setCommentAttribute(c, "text", "New");
    expect(changes).toHaveLength(1);
    expect(doc.slice(changes[0].from, changes[0].to)).toBe('"Old \\"body\\""');
    expect(apply(doc, changes)).toBe('A [b]{.comment author="Ada" date="2026-10-28T13:00" text="New"} c.');
    expect(setCommentAttribute(c, "author", "Ada")).toEqual([]);
  });

  it("resolves and reopens with a bare resolved=true", () => {
    const resolved = apply(doc, setResolved(only(doc), true));
    expect(resolved).toBe('A [b]{.comment author="Ada" date="2026-10-28T13:00" text="Old \\"body\\"" resolved=true} c.');
    expect(only(resolved).resolved).toBe(true);
    expect(setResolved(only(resolved), true)).toEqual([]);
    expect(apply(resolved, setResolved(only(resolved), false))).toBe(doc);
  });

  it("removes the comment and keeps its anchored text", () => {
    const nested = "Keep [the *anchored* [@knuth1984] text]{.comment text=\"x\"} as is.";
    expect(apply(nested, removeComment(only(nested)))).toBe("Keep the *anchored* [@knuth1984] text as is.");
  });

  it("works on unquoted and single-quoted values", () => {
    const loose = "[x]{.comment author=Ada text='single quoted'} [y]{.comment text=plain}";
    const [a, b] = parseComments(loose);
    expect([a.author, b.body]).toEqual(["Ada", "plain"]);
    expect(a.body).toBe("single quoted");
    expect(apply(loose, setCommentAttribute(b, "text", "now quoted"))).toBe("[x]{.comment author=Ada text='single quoted'} [y]{.comment text=\"now quoted\"}");
  });
});

describe("parseComments", () => {
  it("finds comments over citations, math and links, and nested ones", () => {
    const text =
      'See [@knuth1984]{.cite} and [[@knuth1984; @lamport1994]]{.comment author="A" text="Both?"}, ' +
      '[$x^2$ and [a link](https://x.org)]{.comment text="Math"} and [outer [inner]{.comment text="I"} end]{.comment text="O"}.';
    const found = parseComments(text);
    expect(found.map((c) => c.body)).toEqual(["Both?", "Math", "O", "I"]);
    expect(found[0].text).toBe("[@knuth1984; @lamport1994]");
    expect(found[2].text).toBe('outer [inner]{.comment text="I"} end');
    expect(commentAt(found, found[3].textFrom + 1)?.body).toBe("I");
    expect(commentAt(found, found[2].textFrom + 1)?.body).toBe("O");
    expect(commentAt(found, 0)).toBeNull();
  });

  it("spans soft line breaks but not paragraphs, and ignores code and other spans", () => {
    const text = [
      "[over two\nlines]{.comment text=\"ok\"}",
      "",
      "[broken",
      "",
      'paragraph]{.comment text="no"} `[code]{.comment text="no"}` \\[escaped]{.comment text="no"} [styled]{.smallcaps}',
      "",
      "```",
      '[fenced]{.comment text="no"}',
      "```",
      '![image]{.comment text="no"}',
    ].join("\n");
    expect(parseComments(text).map((c) => c.body)).toEqual(["ok"]);
  });

  it("reports absolute offsets with a base", () => {
    const c = parseComments('x [y]{.comment text="z"}', 100)[0];
    expect([c.from, c.textFrom, c.textTo, c.attrsFrom, c.to]).toEqual([102, 103, 104, 105, 124]);
  });

  it("lists comments across parts with their lines, reusing unchanged parts", () => {
    const parts = [
      { file: "a.md", content: '# A\n\nText [one]{.comment author="Ada" text="1"}.\n' },
      { file: "b.md", content: "# B\n\nNo comments.\n" },
      { file: "c.md", content: '[two]{.comment text="2"}\n\nline\n\nand [three]{.comment text="3" resolved=true}' },
    ];
    const list = commentsInParts(parts);
    expect(list.map((c) => [c.file, c.line, c.comment.body, c.comment.resolved])).toEqual([
      ["a.md", 2, "1", false],
      ["c.md", 0, "2", false],
      ["c.md", 4, "3", true],
    ]);
    expect(commentsInParts(parts)[0]).toBe(list[0]);
  });

  it("shortens the anchored text to plain words", () => {
    expect(plainExcerpt("the *anchored*\n[inner]{.comment text=\"x\"} words")).toBe("the anchored inner words");
    expect(plainExcerpt("a".repeat(100), 10)).toBe("aaaaaaaaa…");
  });
});
