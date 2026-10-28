import { Check, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { createProjectDialog } from "@/actions";
import type { TemplateId } from "@/lib/api";
import { LANGUAGES, TEMPLATES, type TemplateInfo } from "@/lib/templates";
import { updateMeta } from "@/session";
import { store, useStore, type GalleryMode } from "@/store";
import { notify } from "./Toaster";
import { Button, Checkbox, Dialog, Field, Input, Select, cx } from "./ui";

const LINE_WIDTHS = [100, 92, 97, 88, 95, 70, 100, 90, 96, 84, 93, 60];

function Lines({ count, offset = 0 }: { count: number; offset?: number }) {
  return (
    <div className="space-y-[3px]">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="h-[2px] rounded-full bg-zinc-300"
          style={{ width: `${LINE_WIDTHS[(i + offset) % LINE_WIDTHS.length]}%` }}
        />
      ))}
    </div>
  );
}

/** A tiny drawing of the first page: one or two columns, or a chapter opening. */
function PageThumbnail({ layout }: { layout: TemplateInfo["layout"] }) {
  const pad = layout.margins === "wide" ? "px-[18%]" : "px-[11%]";
  return (
    <div
      aria-hidden
      className={cx(
        "mx-auto flex aspect-[3/4] w-full max-w-28 flex-col gap-[5px] overflow-hidden rounded-[3px] bg-white py-[11%] shadow-sm ring-1 ring-zinc-200",
        pad,
      )}
    >
      {layout.chapters ? (
        <>
          <div className="mt-[8%] h-[3px] w-[28%] rounded-full bg-zinc-400" />
          <div className="h-[6px] w-[62%] rounded-full bg-zinc-700" />
          <div className="mb-[6%] h-px w-full bg-zinc-300" />
          <Lines count={layout.margins === "wide" ? 10 : 12} />
        </>
      ) : (
        <>
          <div className="mx-auto h-[5px] w-[72%] rounded-full bg-zinc-700" />
          <div className="mx-auto h-[2px] w-[40%] rounded-full bg-zinc-400" />
          <div className="mx-auto mb-[3%] w-[80%]">
            <Lines count={2} offset={3} />
          </div>
          {layout.columns === 2 ? (
            <div className="grid grid-cols-2 gap-[8%]">
              <div className="space-y-[5px]">
                <div className="h-[3px] w-[60%] rounded-full bg-zinc-500" />
                <Lines count={8} />
              </div>
              <div className="space-y-[5px]">
                <Lines count={4} offset={5} />
                <div className="aspect-[4/3] w-full rounded-[2px] bg-indigo-100" />
                <Lines count={2} offset={2} />
              </div>
            </div>
          ) : (
            <div className="space-y-[5px]">
              <div className="h-[3px] w-[34%] rounded-full bg-zinc-500" />
              <Lines count={layout.margins === "wide" ? 7 : 8} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TemplateCard({ template, selected, onPick }: { template: TemplateInfo; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onPick}
      className={cx(
        "relative flex flex-col gap-2 rounded-lg border p-2.5 text-left transition-colors cursor-default",
        "focus-visible:outline-2 focus-visible:outline-accent",
        selected ? "border-accent bg-accent-soft" : "border-line hover:bg-raised",
      )}
    >
      {selected && (
        <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-fg">
          <Check size={11} strokeWidth={3} />
        </span>
      )}
      <div className="rounded-md bg-raised p-2">
        <PageThumbnail layout={template.layout} />
      </div>
      <div>
        <div className="text-[13px] font-medium text-fg">{template.label}</div>
        <div className="text-[11px] leading-snug text-muted">{template.description}</div>
      </div>
    </button>
  );
}

function Gallery({ value, onPick }: { value: TemplateId; onPick: (id: TemplateId) => void }) {
  return (
    <div role="radiogroup" aria-label="Template" className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2.5">
      {TEMPLATES.map((t) => (
        <TemplateCard key={t.id} template={t} selected={value === t.id} onPick={() => onPick(t.id)} />
      ))}
    </div>
  );
}

function CreateForm({ onClose }: { onClose: () => void }) {
  const [template, setTemplate] = useState<TemplateId>("article");
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState("en");
  const [sample, setSample] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      if (await createProjectDialog({ template, title: title.trim(), language, sample })) onClose();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
        <Gallery value={template} onPick={setTemplate} />
        <div className="grid grid-cols-[1fr_11rem] gap-3">
          <Field label="Title">
            <Input data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled paper" />
          </Field>
          <Field label="Language">
            <Select className="w-full" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Checkbox
          checked={sample}
          onChange={setSample}
          label="Start from sample"
          hint="A short document that shows citations, equations, figures and tables"
        />
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3">
        <span className="mr-auto text-[11px] text-faint">You choose the folder next. You can change the template later.</span>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy && <LoaderCircle size={14} className="animate-spin" />}
          Continue…
        </Button>
      </div>
    </form>
  );
}

function ChangeForm({ onClose }: { onClose: () => void }) {
  const current = useStore((s) => s.meta?.template ?? "article");
  return (
    <div className="flex min-h-0 flex-col">
      <p className="shrink-0 px-5 pt-1 text-xs text-muted">Your text stays the same; only the layout changes.</p>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        <Gallery
          value={current}
          onPick={(template) => {
            if (template !== current) updateMeta({ template });
            onClose();
          }}
        />
      </div>
    </div>
  );
}

export function TemplateGallery({ mode }: { mode: GalleryMode }) {
  const close = () => store.set({ gallery: null });
  return (
    <Dialog title={mode === "create" ? "New paper" : "Change template"} onClose={close} className="max-w-[46rem]">
      {mode === "create" ? <CreateForm onClose={close} /> : <ChangeForm onClose={close} />}
    </Dialog>
  );
}
