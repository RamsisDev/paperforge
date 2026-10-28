import { SpellEngine } from "./engine";
import type { DictionarySource, SpellRequest, SpellResponse } from "./protocol";

// The project compiles against the DOM lib; the webworker lib cannot be mixed into it.
const scope = self as unknown as {
  onmessage: (event: MessageEvent<SpellRequest>) => void;
  postMessage: (response: SpellResponse) => void;
};

const engines = new Map<string, Promise<SpellEngine>>();

async function text(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

function engine(source: DictionarySource): Promise<SpellEngine> {
  let loading = engines.get(source.language);
  if (!loading) {
    loading = Promise.all([text(source.aff), text(source.dic)]).then(([aff, dic]) => new SpellEngine(aff, dic));
    loading.catch(() => engines.delete(source.language));
    engines.set(source.language, loading);
  }
  return loading;
}

scope.onmessage = async (event) => {
  const request = event.data;
  let response: SpellResponse;
  try {
    const speller = await engine(request.dictionary);
    const words = request.type === "check" ? speller.misspelled(request.words) : speller.suggest(request.word);
    response = { id: request.id, ok: true, words };
  } catch (e) {
    response = { id: request.id, ok: false, error: String(e) };
  }
  scope.postMessage(response);
};
