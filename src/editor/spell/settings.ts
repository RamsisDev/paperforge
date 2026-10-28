import { notify } from "@/components/Toaster";
import { api } from "@/lib/api";
import { store, useStore } from "@/store";
import { dictionaryFor } from "./dictionaries";
import type { DictionarySource } from "./protocol";
import { mergeWords, normalizeWord } from "./tokens";

const ENABLED_KEY = "paperforge.spellcheck";
const USER_WORDS_KEY = "paperforge.dictionary";

function storedUserWords(): string[] {
  try {
    const words: unknown = JSON.parse(localStorage.getItem(USER_WORDS_KEY) ?? "[]");
    return Array.isArray(words) ? words.filter((w): w is string => typeof w === "string") : [];
  } catch {
    return [];
  }
}

let enabled = localStorage.getItem(ENABLED_KEY) !== "0";
let userWords = storedUserWords();
let projectWords: string[] = [];
/** Ignored for this session only, in every project. */
const ignoredWords = new Set<string>();
let listed = mergeWords(projectWords, userWords, ignoredWords);
const listeners = new Set<() => void>();

function changed() {
  listed = mergeWords(projectWords, userWords, ignoredWords);
  for (const listener of listeners) listener();
}

export function onSpellSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function spellCheckEnabled(): boolean {
  return enabled;
}

export function setSpellCheck(on: boolean) {
  enabled = on;
  localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  changed();
}

/** The project's, the user's and the ignored words. */
export function listedWords(): ReadonlySet<string> {
  return listed;
}

/** The dictionary to check the open project with, or null when spell check is off or unsupported. */
export function activeDictionary(): DictionarySource | null {
  return enabled ? dictionaryFor(store.get().meta?.language) : null;
}

export async function addToProjectDictionary(word: string) {
  const dir = store.get().dir;
  word = normalizeWord(word);
  if (!dir || !word) return;
  projectWords = [...projectWords, word];
  changed();
  try {
    const words = await api.addToDictionary(dir, [word]);
    if (store.get().dir === dir) projectWords = words;
  } catch (e) {
    projectWords = projectWords.filter((w) => w !== word);
    notify(`Could not add “${word}” to the project dictionary: ${e}`, "error");
  }
  changed();
}

export function addToUserDictionary(word: string) {
  word = normalizeWord(word);
  if (!word || userWords.includes(word)) return;
  userWords = [...userWords, word];
  localStorage.setItem(USER_WORDS_KEY, JSON.stringify(userWords));
  changed();
}

export function ignoreWord(word: string) {
  ignoredWords.add(normalizeWord(word));
  changed();
}

async function loadProjectWords(dir: string | null) {
  projectWords = [];
  changed();
  if (!dir) return;
  try {
    const words = await api.readDictionary(dir);
    if (store.get().dir !== dir) return;
    projectWords = Array.isArray(words) ? words : [];
  } catch (e) {
    console.warn(`Project dictionary not loaded: ${e}`);
  }
  changed();
}

useStore.subscribe((s, prev) => {
  if (s.dir !== prev.dir) void loadProjectWords(s.dir);
  else if (s.meta?.language !== prev.meta?.language) changed();
});
