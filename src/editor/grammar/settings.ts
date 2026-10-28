import { store, useStore } from "@/store";
import { dialectFor } from "./dialects";
import type { GrammarDialect } from "./protocol";

const ENABLED_KEY = "paperforge.grammar";

let enabled = localStorage.getItem(ENABLED_KEY) !== "0";
/** Ignored for this session only, in every project. */
const ignored = new Set<string>();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

export function onGrammarSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function grammarEnabled(): boolean {
  return enabled;
}

export function setGrammarCheck(on: boolean) {
  enabled = on;
  localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  changed();
}

export function ignoredLints(): ReadonlySet<string> {
  return ignored;
}

export function ignoreLint(key: string) {
  ignored.add(key);
  changed();
}

/** The dialect to check the open project with, or null when grammar is off or the language is not English. */
export function activeDialect(): GrammarDialect | null {
  return enabled ? dialectFor(store.get().meta?.language) : null;
}

useStore.subscribe((s, prev) => {
  if (s.meta?.language !== prev.meta?.language) changed();
});
