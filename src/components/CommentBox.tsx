import { Check, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, Field, Input, MOD, Textarea } from "./ui";

export interface CommentBoxProps {
  /** Plain text of the commented passage. */
  excerpt: string;
  /** The comment being edited; absent when adding one. */
  existing?: { author: string; date: string; body: string; resolved: boolean };
  /** The stored commenter name; the box asks for one while it is empty. */
  author: string;
  onSubmit: (body: string, author: string) => void;
  onCancel: () => void;
  onResolve?: (resolved: boolean) => void;
  onDelete?: () => void;
}

export function CommentBox({ excerpt, existing, author, onSubmit, onCancel, onResolve, onDelete }: CommentBoxProps) {
  const [body, setBody] = useState(existing?.body ?? "");
  const [name, setName] = useState(author);
  const askName = !author;
  const ready = body.trim() !== "" && name.trim() !== "" && body !== existing?.body;
  const submit = () => ready && onSubmit(body.trim(), name.trim());

  return (
    <div
      role="dialog"
      aria-label={existing ? "Edit comment" : "Add comment"}
      className="w-72 space-y-2 p-3"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div className="truncate text-[11px] text-faint" title={excerpt}>
        {existing ? `${existing.author || "Anonymous"} · ${existing.date.replace("T", " ")}` : `On “${excerpt}”`}
      </div>
      {askName && (
        <Field label="Your name" hint="shown on your comments">
          <Input aria-label="Your name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />
        </Field>
      )}
      <Textarea
        aria-label="Comment"
        autoFocus={!askName}
        maxRows={8}
        placeholder="Write a comment…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex items-center gap-1.5">
        {existing && onResolve && (
          <Button size="sm" variant="ghost" onClick={() => onResolve(!existing.resolved)}>
            {existing.resolved ? <RotateCcw size={13} /> : <Check size={13} />}
            {existing.resolved ? "Reopen" : "Resolve"}
          </Button>
        )}
        {existing && onDelete && (
          <Button size="sm" variant="ghost" aria-label="Delete comment" title="Delete comment, keep the text" onClick={onDelete}>
            <Trash2 size={13} />
          </Button>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!ready} title={`${MOD}Enter`} onClick={submit}>
          {existing ? "Save" : "Comment"}
        </Button>
      </div>
    </div>
  );
}
