import type { GrammarDialect, GrammarLint, GrammarRequest, GrammarResponse } from "./protocol";

type Pending = { resolve: (lints: GrammarLint[][]) => void; reject: (error: string) => void };

/** Paragraph results kept for unchanged paragraphs; the oldest go first. */
const CACHE_SIZE = 2000;

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();
const cache = new Map<string, Promise<GrammarLint[]>>();

function grammarWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<GrammarResponse>) => {
      const response = event.data;
      const request = pending.get(response.id);
      pending.delete(response.id);
      if (response.ok) request?.resolve(response.lints);
      else request?.reject(response.error);
    };
  }
  return worker;
}

function request(dialect: GrammarDialect, texts: string[]): Promise<GrammarLint[][]> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    grammarWorker().postMessage({ id, dialect, texts } satisfies GrammarRequest);
  });
}

/** Harper's lints for each paragraph; only paragraphs not seen before go to the worker. */
export function lintParagraphs(dialect: GrammarDialect, texts: string[]): Promise<GrammarLint[][]> {
  const keys = texts.map((text) => `${dialect}\n${text}`);
  const missing = [...new Set(keys.filter((key) => !cache.has(key)))];
  if (missing.length) {
    const batch = request(dialect, missing.map((key) => key.slice(dialect.length + 1)));
    missing.forEach((key, i) => {
      const lints = batch.then((all) => all[i]);
      lints.catch(() => cache.delete(key));
      cache.set(key, lints);
    });
    for (const key of cache.keys()) {
      if (cache.size <= CACHE_SIZE) break;
      cache.delete(key);
    }
  }
  return Promise.all(keys.map((key) => cache.get(key) ?? Promise.resolve([])));
}
