/** Names of Harper's English dialects; the worker maps them to its enum. */
export type GrammarDialect = "American" | "British" | "Australian" | "Canadian" | "Indian";

export interface GrammarSuggestion {
  kind: "replace" | "remove" | "insert";
  text: string;
}

/** A Harper lint as plain data; `start` and `end` are UTF-16 offsets into the linted text. */
export interface GrammarLint {
  start: number;
  end: number;
  kind: string;
  message: string;
  problem: string;
  suggestions: GrammarSuggestion[];
}

export interface GrammarRequest {
  id: number;
  dialect: GrammarDialect;
  texts: string[];
}

export type GrammarResponse = { id: number; ok: true; lints: GrammarLint[][] } | { id: number; ok: false; error: string };
