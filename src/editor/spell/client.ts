import type { DictionarySource, SpellRequest, SpellResponse } from "./protocol";

type Pending = { resolve: (words: string[]) => void; reject: (error: string) => void };

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();
/** language → word → whether the dictionary knows it; the worker is asked about each word once. */
const verdicts = new Map<string, Map<string, boolean>>();
const suggestionCache = new Map<string, Promise<string[]>>();

function spellWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<SpellResponse>) => {
      const response = event.data;
      const request = pending.get(response.id);
      pending.delete(response.id);
      if (response.ok) request?.resolve(response.words);
      else request?.reject(response.error);
    };
  }
  return worker;
}

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type Request = WithoutId<SpellRequest>;

function request(message: Request): Promise<string[]> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    spellWorker().postMessage({ ...message, id });
  });
}

/** The words of `words` that `dictionary` does not know. */
export async function misspelled(dictionary: DictionarySource, words: Iterable<string>): Promise<Set<string>> {
  let known = verdicts.get(dictionary.language);
  if (!known) verdicts.set(dictionary.language, (known = new Map()));
  const all = [...new Set(words)];
  const unknown = all.filter((w) => !known.has(w));
  if (unknown.length) {
    const bad = new Set(await request({ type: "check", dictionary, words: unknown }));
    for (const w of unknown) known.set(w, !bad.has(w));
  }
  return new Set(all.filter((w) => known.get(w) === false));
}

export function suggestions(dictionary: DictionarySource, word: string): Promise<string[]> {
  const key = `${dictionary.language}\n${word}`;
  let found = suggestionCache.get(key);
  if (!found) {
    found = request({ type: "suggest", dictionary, word });
    found.catch(() => suggestionCache.delete(key));
    suggestionCache.set(key, found);
  }
  return found;
}
