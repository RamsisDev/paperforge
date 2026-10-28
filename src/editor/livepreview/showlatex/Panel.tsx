import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Code2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { notify } from "@/components/Toaster";
import { Button, IconButton } from "@/components/ui";
import type { BlockLatex } from "@/lib/api";
import { latexHighlight } from "./highlight";

export type Lookup =
  | { status: "loading" }
  | { status: "none" }
  | { status: "error"; message: string }
  | { status: "ok"; block: BlockLatex };

/** Read-only LaTeX numbered with the fragment's own lines. */
function LatexView({ latex, firstLine, onEscape }: { latex: string; firstLine: number; onEscape: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: latex,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.lineWrapping,
          lineNumbers({ formatNumber: (n) => String(n + firstLine - 1) }),
          latexHighlight,
          keymap.of([{ key: "Escape", run: () => (escape.current(), true) }]),
        ],
      }),
    });
    return () => view.destroy();
  }, [latex, firstLine]);
  return <div ref={host} className="pf-showlatex-code max-h-64 overflow-auto rounded-md border border-line" />;
}

export function ShowLatexPanel({
  lookup,
  onConvert,
  onClose,
}: {
  lookup: Lookup;
  onConvert: (block: BlockLatex) => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const block = lookup.status === "ok" ? lookup.block : null;
  const lines = block && (block.markdownFrom === block.markdownTo ? `line ${block.markdownFrom}` : `lines ${block.markdownFrom}–${block.markdownTo}`);
  return (
    <div
      role="dialog"
      aria-label="Generated LaTeX"
      className="w-[560px] max-w-[80vw] space-y-2 p-3 font-sans"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        onClose();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-fg">
          <Code2 size={13} /> Generated LaTeX
          {lines && <span className="font-normal text-faint">· Markdown {lines}</span>}
        </span>
        <IconButton label="Close" className="h-6 w-6" onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
      {lookup.status === "loading" && <p className="text-xs text-muted">Reading the last typeset…</p>}
      {lookup.status === "none" && <p className="text-xs text-muted">Typeset to see the LaTeX of this block.</p>}
      {lookup.status === "error" && <p className="text-xs text-danger">{lookup.message}</p>}
      {block?.stale && (
        <p role="status" className="text-xs text-warn">
          Out of date — typeset again to see the LaTeX of the current text.
        </p>
      )}
      {block && <LatexView latex={block.latex} firstLine={block.fromLine} onEscape={onClose} />}
      {block && confirming && (
        <div role="alert" className="space-y-1 rounded-md border border-line bg-raised p-2 text-xs text-muted">
          <p>
            Replaces Markdown {lines} with this LaTeX in a <code className="font-mono">{"```{=latex}"}</code> block. The
            editor no longer renders it, and citations and cross references inside stay as raw{" "}
            <code className="font-mono">\cite</code> and <code className="font-mono">\ref</code>.
          </p>
        </div>
      )}
      <div className="flex justify-end gap-1.5">
        {block && !confirming && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                navigator.clipboard.writeText(block.latex).then(
                  () => notify("LaTeX copied"),
                  (e) => notify(String(e), "error"),
                )
              }
            >
              Copy
            </Button>
            <Button
              size="sm"
              disabled={block.stale}
              title={block.stale ? "Typeset again first" : undefined}
              onClick={() => setConfirming(true)}
            >
              Convert to raw LaTeX…
            </Button>
          </>
        )}
        {block && confirming && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => onConvert(block)}>
              Convert
            </Button>
          </>
        )}
        {!block && (
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        )}
      </div>
    </div>
  );
}
