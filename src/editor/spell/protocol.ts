/** Where a language's Hunspell files are served from. */
export interface DictionarySource {
  language: string;
  aff: string;
  dic: string;
}

export type SpellRequest =
  | { id: number; type: "check"; dictionary: DictionarySource; words: string[] }
  | { id: number; type: "suggest"; dictionary: DictionarySource; word: string };

export type SpellResponse = { id: number; ok: true; words: string[] } | { id: number; ok: false; error: string };
