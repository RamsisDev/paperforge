// Relative paths because the packages only export their Node entry point. These are asset URLs:
// the worker fetches the files the first time a language is checked.
import enAff from "../../../node_modules/dictionary-en/index.aff?url&no-inline";
import enDic from "../../../node_modules/dictionary-en/index.dic?url&no-inline";
import esAff from "../../../node_modules/dictionary-es/index.aff?url&no-inline";
import esDic from "../../../node_modules/dictionary-es/index.dic?url&no-inline";
import type { DictionarySource } from "./protocol";

const DICTIONARIES: Record<string, DictionarySource> = {
  en: { language: "en", aff: enAff, dic: enDic },
  es: { language: "es", aff: esAff, dic: esDic },
};

/** The bundled dictionary for a `meta.language` such as "en" or "es-MX", if there is one. */
export function dictionaryFor(language: string | undefined): DictionarySource | null {
  const base = (language || "en").toLowerCase().split(/[-_]/)[0];
  return DICTIONARIES[base] ?? null;
}
