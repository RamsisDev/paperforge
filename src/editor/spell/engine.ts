import nspell from "nspell";
import { normalizeWord } from "./tokens";

export const SUGGESTION_LIMIT = 5;

/** A Hunspell dictionary loaded into nspell; runs in the spell worker (and in tests). */
export class SpellEngine {
  private readonly speller: ReturnType<typeof nspell>;

  constructor(aff: string, dic: string) {
    this.speller = nspell(aff, dic);
  }

  correct(word: string): boolean {
    return this.speller.correct(normalizeWord(word));
  }

  /** The words of `words` the dictionary does not know. */
  misspelled(words: string[]): string[] {
    return words.filter((w) => !this.correct(w));
  }

  suggest(word: string, limit = SUGGESTION_LIMIT): string[] {
    return this.speller.suggest(normalizeWord(word)).slice(0, limit);
  }
}
