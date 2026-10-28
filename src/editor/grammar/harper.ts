import { createBinaryModuleFromUrl, Dialect, LocalLinter, SuggestionKind, type Lint } from "harper.js";
import type { GrammarDialect, GrammarLint, GrammarSuggestion } from "./protocol";

const SUGGESTION_KINDS: Record<number, GrammarSuggestion["kind"]> = {
  [SuggestionKind.Replace]: "replace",
  [SuggestionKind.Remove]: "remove",
  [SuggestionKind.InsertAfter]: "insert",
};

function plain(lint: Lint): GrammarLint {
  const span = lint.span();
  const result: GrammarLint = {
    start: span.start,
    end: span.end,
    kind: lint.lint_kind(),
    message: lint.message(),
    problem: lint.get_problem_text(),
    suggestions: lint.suggestions().map((s) => {
      const suggestion = { kind: SUGGESTION_KINDS[s.kind()] ?? "replace", text: s.get_replacement_text() };
      s.free();
      return suggestion;
    }),
  };
  span.free();
  lint.free();
  return result;
}

/** Lints Markdown paragraphs with Harper, loading the slim binary (the only build that needs a single file) from `wasmUrl`. */
export function harperLinter(wasmUrl: string): (dialect: GrammarDialect, texts: string[]) => Promise<GrammarLint[][]> {
  const binary = createBinaryModuleFromUrl(wasmUrl, "slim");
  const linters = new Map<GrammarDialect, Promise<LocalLinter>>();

  async function create(dialect: GrammarDialect): Promise<LocalLinter> {
    const linter = new LocalLinter({ binary, dialect: Dialect[dialect] });
    // Spelling is the spell checker's job; two squiggles on one word would be noise.
    await linter.setLintConfig({ SpellCheck: false });
    return linter;
  }

  function linterFor(dialect: GrammarDialect): Promise<LocalLinter> {
    let linter = linters.get(dialect);
    if (!linter) {
      linter = create(dialect);
      linter.catch(() => linters.delete(dialect));
      linters.set(dialect, linter);
    }
    return linter;
  }

  return async (dialect, texts) => {
    const linter = await linterFor(dialect);
    const lints: GrammarLint[][] = [];
    for (const text of texts) lints.push((await linter.lint(text, { language: "markdown" })).map(plain));
    return lints;
  };
}
