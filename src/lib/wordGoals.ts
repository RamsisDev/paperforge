export interface WordGoals {
  /** Words for the whole document. */
  total: number | null;
  /** Words to add since the project was opened in this run of the app. */
  session: number | null;
}

const KEY = "paperforge.wordGoals";
const NO_GOALS: WordGoals = { total: null, session: null };

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function load(): Record<string, WordGoals> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!stored || typeof stored !== "object") return {};
    const goals: Record<string, WordGoals> = {};
    for (const [dir, g] of Object.entries(stored as Record<string, Partial<WordGoals>>)) {
      const parsed = { total: positive(g?.total), session: positive(g?.session) };
      if (parsed.total || parsed.session) goals[dir] = parsed;
    }
    return goals;
  } catch {
    return {};
  }
}

let goals: Record<string, WordGoals> | null = null;
const listeners = new Set<() => void>();
const sessionStart = new Map<string, number>();

export function onWordGoals(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The goals of the project in `dir`; the same object until they change. */
export function wordGoals(dir: string | null): WordGoals {
  goals ??= load();
  return (dir && goals[dir]) || NO_GOALS;
}

export function setWordGoals(dir: string, next: WordGoals) {
  goals ??= load();
  const parsed = { total: positive(next.total), session: positive(next.session) };
  const { [dir]: _, ...rest } = goals;
  goals = parsed.total || parsed.session ? { ...rest, [dir]: parsed } : rest;
  localStorage.setItem(KEY, JSON.stringify(goals));
  for (const listener of listeners) listener();
}

/** Words written in this session: the count now minus the first count seen for the project. */
export function sessionWords(dir: string, words: number): number {
  if (!sessionStart.has(dir)) sessionStart.set(dir, words);
  return Math.max(0, words - sessionStart.get(dir)!);
}

/** `words` towards `goal`, from 0 to 1. */
export function goalProgress(words: number, goal: number): number {
  return Math.min(1, Math.max(0, words / goal));
}
