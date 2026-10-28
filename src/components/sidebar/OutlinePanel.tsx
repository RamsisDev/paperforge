import { useDeferredValue, useMemo } from "react";
import { formatting, insertInline } from "@/editor/commands";
import { withEditor } from "@/editor/bridge";
import { headings, labels } from "@/lib/outline";
import { jumpTo, useStore } from "@/store";
import { Button } from "../ui";

const KIND_LABELS = { sec: "Sections", fig: "Figures", tbl: "Tables", eq: "Equations" } as const;

export function OutlinePanel() {
  const body = useDeferredValue(useStore((s) => s.body));
  const outline = useMemo(() => headings(body), [body]);
  const refs = useMemo(() => labels(body), [body]);

  return (
    <div className="space-y-5 p-3">
      <section>
        <h3 className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Outline</h3>
        {outline.length === 0 ? (
          <div className="space-y-2 px-1 text-xs text-muted">
            <p>Headings appear here as you write them.</p>
            <Button size="sm" onClick={() => withEditor(formatting.h1)}>
              Add a section
            </Button>
          </div>
        ) : (
          <ul>
            {outline.map((h) => (
              <li key={`${h.line}-${h.text}`}>
                <button
                  onClick={() => jumpTo("paper.md", h.line)}
                  className="block w-full truncate rounded-md py-1 pr-2 text-left text-[13px] text-fg hover:bg-raised cursor-default"
                  style={{ paddingLeft: 4 + (h.level - 1) * 14 }}
                  title={h.text}
                >
                  <span className={h.level === 1 ? "font-medium" : "text-muted"}>{h.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(Object.keys(KIND_LABELS) as (keyof typeof KIND_LABELS)[]).map((kind) =>
        refs[kind].length === 0 ? null : (
          <section key={kind}>
            <h3 className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              {KIND_LABELS[kind]} <span className="font-normal normal-case text-faint">· click to reference</span>
            </h3>
            <div className="flex flex-wrap gap-1 px-1">
              {refs[kind].map((id) => (
                <button
                  key={id}
                  onClick={() => withEditor((v) => insertInline(v, `@${id}`))}
                  className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted hover:border-accent hover:text-fg cursor-default"
                >
                  @{id}
                </button>
              ))}
            </div>
          </section>
        ),
      )}
    </div>
  );
}
