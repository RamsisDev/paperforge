import type { Diagnostic } from "./api";
import { bestLine } from "./textmatch";

export interface Located {
  diagnostic: Diagnostic;
  /** Where the editor should jump: the Markdown line when it can be found. */
  file: "paper.md" | "refs.bib" | "paper.tex" | null;
  /** 0-based. */
  line: number | null;
}

/** Maps paper.tex lines back to paper.md by matching the generated text against the source. */
export function locate(diagnostics: Diagnostic[], body: string): Located[] {
  const lines = body.split("\n");
  return diagnostics.map((diagnostic) => {
    if (diagnostic.file === "refs.bib" && diagnostic.line) {
      return { diagnostic, file: "refs.bib", line: diagnostic.line - 1 };
    }
    if (diagnostic.file === "paper.tex" && diagnostic.line) {
      const match = diagnostic.source ? bestLine(diagnostic.source, lines) : null;
      return match
        ? { diagnostic, file: "paper.md", line: match.line }
        : { diagnostic, file: "paper.tex", line: diagnostic.line - 1 };
    }
    const citation = /Citation `([^']+)'/.exec(diagnostic.message);
    if (citation) {
      const at = lines.findIndex((l) => l.includes(`@${citation[1]}`));
      if (at >= 0) return { diagnostic, file: "paper.md", line: at };
    }
    return { diagnostic, file: null, line: null };
  });
}
