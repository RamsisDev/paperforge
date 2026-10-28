import type { Diagnostic, Part } from "./api";
import { bestLineInParts, findInParts } from "./parts";
import { bestLine } from "./textmatch";

export interface Located {
  diagnostic: Diagnostic;
  /** Where the editor should jump: a Markdown part when the line can be found, else refs.bib or paper.tex. */
  file: string | null;
  /** 0-based. */
  line: number | null;
}

/**
 * Maps generated-LaTeX lines back to Markdown: through the fragment's block markers when the
 * backend resolved them, else by matching the generated text against the parts.
 */
export function locate(diagnostics: Diagnostic[], parts: Part[]): Located[] {
  const byFile = new Map(parts.map((p) => [p.file, p]));
  return diagnostics.map((diagnostic): Located => {
    if (diagnostic.file === "refs.bib" && diagnostic.line) {
      return { diagnostic, file: "refs.bib", line: diagnostic.line - 1 };
    }
    const part = diagnostic.part ? byFile.get(diagnostic.part) : undefined;
    // The part may have been edited since the compile; a line past its end is stale.
    if (part && diagnostic.partLine && diagnostic.partLine <= part.content.split("\n").length) {
      return { diagnostic, file: part.file, line: diagnostic.partLine - 1 };
    }
    if (part && diagnostic.source) {
      const match = bestLine(diagnostic.source, part.content.split("\n"));
      if (match) return { diagnostic, file: part.file, line: match.line };
    }
    if (diagnostic.source && !part) {
      const match = bestLineInParts(diagnostic.source, parts);
      if (match) return { diagnostic, file: match.file, line: match.line };
    }
    const citation = /Citation `([^']+)'/.exec(diagnostic.message);
    if (citation) {
      const at = findInParts(parts, `@${citation[1]}`);
      if (at) return { diagnostic, ...at };
    }
    if (part) return { diagnostic, file: part.file, line: 0 };
    if (diagnostic.file === "paper.tex" && diagnostic.line) {
      return { diagnostic, file: "paper.tex", line: diagnostic.line - 1 };
    }
    return { diagnostic, file: null, line: null };
  });
}
