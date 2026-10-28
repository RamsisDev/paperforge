import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Author } from "@/lib/api";
import { LANGUAGES, TEMPLATES, templateInfo } from "@/lib/templates";
import { updateMeta } from "@/session";
import { useStore } from "@/store";
import { Button, Field, Input, Select, Textarea, cx } from "../ui";

export function PaperPanel() {
  const meta = useStore((s) => s.meta);
  const dir = useStore((s) => s.dir);
  const [keywords, setKeywords] = useState("");

  // Seeded once per project: re-joining on every keystroke would move the caret.
  useEffect(() => setKeywords(meta?.keywords.join(", ") ?? ""), [dir]);

  if (!meta) return null;

  function setAuthor(index: number, patch: Partial<Author>) {
    updateMeta({ authors: meta!.authors.map((a, i) => (i === index ? { ...a, ...patch } : a)) });
  }

  return (
    <div className="space-y-5 p-4">
      <Field label="Template">
        <div className="grid gap-1.5">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => updateMeta({ template: t.id })}
              className={cx(
                "rounded-lg border px-3 py-2 text-left transition-colors cursor-default",
                meta.template === t.id ? "border-accent bg-accent-soft" : "border-line hover:bg-raised",
              )}
            >
              <div className="text-[13px] font-medium text-fg">{t.label}</div>
              <div className="text-[11px] text-muted">{t.description}</div>
            </button>
          ))}
        </div>
      </Field>

      <Field label="Title">
        <Textarea value={meta.title} maxRows={4} onChange={(e) => updateMeta({ title: e.target.value })} placeholder="Paper title" />
      </Field>

      <Field label="Authors" hint="Order is kept">
        <div className="space-y-2">
          {meta.authors.map((author, i) => (
            <div key={i} className="group relative space-y-1.5 rounded-lg border border-line bg-raised/50 p-2">
              <Input value={author.name} placeholder="Full name" onChange={(e) => setAuthor(i, { name: e.target.value })} />
              <Input
                value={author.affiliation}
                placeholder="Affiliation"
                onChange={(e) => setAuthor(i, { affiliation: e.target.value })}
              />
              <Input
                value={author.email}
                type="email"
                placeholder="Email"
                onChange={(e) => setAuthor(i, { email: e.target.value })}
              />
              {meta.authors.length > 1 && (
                <button
                  aria-label={`Remove ${author.name || "author"}`}
                  onClick={() => updateMeta({ authors: meta.authors.filter((_, j) => j !== i) })}
                  className="absolute -right-2 -top-2 hidden h-5 w-5 items-center justify-center rounded-full border border-line bg-panel text-muted shadow group-hover:flex hover:text-danger"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            className="w-full"
            onClick={() => updateMeta({ authors: [...meta.authors, { name: "", affiliation: "", email: "" }] })}
          >
            <Plus size={14} /> Add author
          </Button>
        </div>
      </Field>

      <Field label="Abstract" hint="Markdown and $math$">
        <Textarea
          value={meta.abstract}
          maxRows={12}
          onChange={(e) => updateMeta({ abstract: e.target.value })}
          placeholder="A short summary of the paper"
        />
      </Field>

      <Field label="Keywords" hint="Comma separated">
        <Input
          value={keywords}
          placeholder="typesetting, LaTeX"
          onChange={(e) => {
            setKeywords(e.target.value);
            updateMeta({ keywords: e.target.value.split(",").map((k) => k.trim()).filter(Boolean) });
          }}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Language">
          <Select className="w-full" value={meta.language} onChange={(e) => updateMeta({ language: e.target.value })}>
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Date">
          <Input value={meta.date} placeholder="Hidden" onChange={(e) => updateMeta({ date: e.target.value })} />
        </Field>
      </div>

      <Field label="BibTeX style" hint="Advanced">
        <Input
          value={meta.bibStyle}
          className="font-mono text-xs"
          placeholder={templateInfo(meta.template).defaultBibStyle}
          onChange={(e) => updateMeta({ bibStyle: e.target.value })}
        />
      </Field>
    </div>
  );
}
