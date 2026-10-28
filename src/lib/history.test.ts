import { describe, expect, it } from "vitest";
import type { DiffSegment, VersionInfo } from "./api";
import { dayLabel, foldSegments, headWords, sessionLabel, timeline, whenLabel, type ShownSegment } from "./history";

const NOW = new Date(2026, 9, 28, 15, 0);

function at(day: number, hour: number, minute = 0, year = 2026): Date {
  return new Date(year, 9, day, hour, minute);
}

let next = 0;
function snapshot(kind: VersionInfo["kind"], date: Date, label: string | null = null): VersionInfo {
  const id = `c${++next}`;
  return { id, shortId: id, kind, label, note: null, summary: "Edited: Method", time: date.getTime() / 1000, author: "Ada", changedParts: [] };
}

function shape(days: ReturnType<typeof timeline>) {
  return days.map((d) => [
    d.label,
    d.entries.map((e) => (e.kind === "autosaves" ? `${e.versions.length} autosaves` : `${e.kind} ${e.version.id}`)),
  ]);
}

function words(n: number, word = "w"): string {
  return Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ");
}

function render(shown: ShownSegment[]): string {
  return shown.map((s) => (s.kind === "fold" ? `[…${s.words}]` : s.kind === "equal" ? s.text : `{${s.kind}:${s.text}}`)).join("");
}

describe("history dates", () => {
  it("names days relative to now", () => {
    expect(dayLabel(at(28, 9), NOW)).toBe("Today");
    expect(dayLabel(at(27, 23, 59), NOW)).toBe("Yesterday");
    expect(dayLabel(at(3, 12), NOW)).toBe("3 Oct");
    expect(dayLabel(at(28, 12, 0, 2025), NOW)).toBe("28 Oct 2025");
    expect(dayLabel(new Date(2026, 0, 1), new Date(2026, 0, 2))).toBe("Yesterday");
    expect(dayLabel(new Date(2025, 11, 31), new Date(2026, 0, 1))).toBe("Yesterday");
  });

  it("shows the time alone today and the date before it otherwise", () => {
    expect(whenLabel(at(28, 14, 2), NOW)).toBe("14:02");
    expect(whenLabel(at(27, 9, 5), NOW)).toBe("27 Oct 09:05");
  });

  it("labels a writing session by its start and end", () => {
    expect(sessionLabel(at(28, 10, 2), at(28, 12, 30), NOW)).toBe("Session 28 Oct 10:02–12:30");
    expect(sessionLabel(at(27, 23, 10), at(28, 0, 40), NOW)).toBe("Session 27 Oct 23:10–28 Oct 00:40");
  });
});

describe("history timeline", () => {
  it("groups by day and folds consecutive autosaves", () => {
    const v = [
      snapshot("autosave", at(28, 14)),
      snapshot("autosave", at(28, 13)),
      snapshot("autosave", at(28, 12)),
      snapshot("version", at(28, 11), "Sent to reviewer"),
      snapshot("autosave", at(28, 10)),
      snapshot("autosave", at(27, 18)),
      snapshot("autosave", at(27, 17)),
      snapshot("version", at(20, 9)),
    ];
    expect(shape(timeline(v, NOW))).toEqual([
      ["Today", ["3 autosaves", `version ${v[3].id}`, `autosave ${v[4].id}`]],
      ["Yesterday", ["2 autosaves"]],
      ["20 Oct", [`version ${v[7].id}`]],
    ]);
  });

  it("is empty without snapshots", () => {
    expect(timeline([], NOW)).toEqual([]);
  });
});

describe("history word diff", () => {
  it("folds a long unchanged run between two changes, keeping context on each side", () => {
    const segments: DiffSegment[] = [
      { kind: "equal", text: words(30, "a") + " " },
      { kind: "delete", text: "old" },
      { kind: "insert", text: "new" },
      { kind: "equal", text: " " + words(40, "b") + " " },
      { kind: "insert", text: "more" },
      { kind: "equal", text: " " + words(5, "c") },
    ];
    const shown = foldSegments(segments, 3, 5);
    expect(render(shown)).toBe(
      "[…27]a27 a28 a29 {delete:old}{insert:new} b0 b1 b2[…34]b37 b38 b39 {insert:more} c0 c1 c2 c3 c4",
    );
    expect(shown.map((s) => s.text).join("")).toBe(segments.map((s) => s.text).join(""));
  });

  it("keeps short unchanged runs and stops context at a paragraph break", () => {
    const short: DiffSegment[] = [
      { kind: "equal", text: "One two " },
      { kind: "insert", text: "three" },
    ];
    expect(foldSegments(short, 3, 5)).toEqual(short);
    const paragraphs: DiffSegment[] = [
      { kind: "insert", text: "New" },
      { kind: "equal", text: " end.\n\n" + words(20) + "\n\nStart " },
      { kind: "delete", text: "gone" },
    ];
    expect(render(foldSegments(paragraphs, 3, 5))).toBe("{insert:New} end.\n\n[…20]\n\nStart {delete:gone}");
  });

  it("folds a part with no change at all", () => {
    expect(foldSegments([{ kind: "equal", text: words(50) }])).toEqual([{ kind: "fold", text: words(50), words: 50 }]);
  });

  it("takes the first words of a long text", () => {
    expect(headWords("one two\nthree four five", 3)).toEqual({ head: "one two\nthree", rest: 2 });
    expect(headWords("short", 3)).toEqual({ head: "short", rest: 0 });
  });
});
