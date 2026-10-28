import { Check, MessageSquarePlus, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { addComment } from "@/editor/comments";
import { commentsInParts, plainExcerpt, removeComment, setCommentAttribute, setResolved, type PartComment } from "@/editor/comments/model";
import { editorBridge, withEditor } from "@/editor/bridge";
import type { TextChange } from "@/editor/figureSyntax";
import { partTitle } from "@/lib/parts";
import { isPartFile, selectInFile, setCommentAuthor, useStore } from "@/store";
import { Button, Checkbox, IconButton, Input, MOD, Textarea, cx } from "../ui";

function edit(file: string, changes: TextChange[]) {
  if (changes.length) editorBridge.edit?.(file, changes);
}

function CommentCard({ item, title }: { item: PartComment; title: string }) {
  const { file, line, comment } = item;
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const save = () => {
    edit(file, setCommentAttribute(comment, "text", body.trim()));
    setEditing(false);
  };

  return (
    <li
      aria-label={`Comment by ${comment.author || "Anonymous"}`}
      className={cx("group rounded-md border border-line bg-panel p-2", comment.resolved && "opacity-60")}
    >
      <div className="flex items-baseline gap-1.5">
        <span className="min-w-0 truncate text-[12px] font-semibold text-fg">{comment.author || "Anonymous"}</span>
        <span className="shrink-0 text-[10px] text-faint">{comment.date.replace("T", " ")}</span>
        {comment.resolved && <span className="ml-auto shrink-0 rounded bg-raised px-1 text-[10px] text-muted">Resolved</span>}
      </div>
      <button
        type="button"
        className="mt-1 block w-full text-left cursor-default"
        title={`${title}, line ${line + 1}`}
        onClick={() => selectInFile(file, line, comment.textFrom, comment.textTo)}
      >
        <span className="block truncate border-l-2 border-[var(--pf-comment-line)] pl-1.5 text-[11px] text-muted">
          {plainExcerpt(comment.text)}
        </span>
      </button>
      {editing ? (
        <div
          className="mt-1.5 space-y-1.5"
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false);
            else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          }}
        >
          <Textarea aria-label="Comment text" autoFocus maxRows={8} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={!body.trim()} title={`${MOD}Enter`} onClick={save}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-1 whitespace-pre-wrap break-words text-[12px] text-fg">{comment.body}</p>
      )}
      <div className="mt-1 flex items-center gap-0.5">
        <span className="min-w-0 flex-1 truncate text-[10px] text-faint">{title}</span>
        {!editing && (
          <IconButton
            label="Edit comment"
            className="h-6 w-6"
            onClick={() => {
              setBody(comment.body);
              setEditing(true);
            }}
          >
            <Pencil size={12} />
          </IconButton>
        )}
        <IconButton
          label={comment.resolved ? "Reopen comment" : "Resolve comment"}
          className="h-6 w-6"
          onClick={() => edit(file, setResolved(comment, !comment.resolved))}
        >
          {comment.resolved ? <RotateCcw size={12} /> : <Check size={13} />}
        </IconButton>
        <IconButton label="Delete comment" className="h-6 w-6" onClick={() => edit(file, removeComment(comment))}>
          <Trash2 size={12} />
        </IconButton>
      </div>
    </li>
  );
}

export function CommentsPanel() {
  const parts = useStore((s) => s.parts);
  const author = useStore((s) => s.commentAuthor);
  const editingMarkdown = useStore((s) => isPartFile(s.activeFile));
  const [showResolved, setShowResolved] = useState(false);
  const all = commentsInParts(parts);
  const titles = useMemo(() => new Map(parts.map((p) => [p.file, partTitle(p)])), [parts]);
  const shown = showResolved ? all : all.filter((c) => !c.comment.resolved);
  const resolved = all.length - all.filter((c) => !c.comment.resolved).length;

  return (
    <div className="space-y-3 p-3">
      <Button className="w-full" disabled={!editingMarkdown} onClick={() => withEditor(addComment)}>
        <MessageSquarePlus size={14} /> Comment on selection
      </Button>
      <label className="flex items-center gap-2 text-[11px] text-muted">
        <span className="shrink-0">Your name</span>
        <Input
          aria-label="Commenter name"
          className="h-7"
          placeholder="Asked on your first comment"
          defaultValue={author}
          key={author}
          onBlur={(e) => e.target.value.trim() !== author && setCommentAuthor(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </label>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-faint">
          {all.length === 0 ? "No comments yet" : `${all.length - resolved} open · ${resolved} resolved`}
        </span>
        <Checkbox checked={showResolved} onChange={setShowResolved} label="Show resolved" />
      </div>
      <ul aria-label="Comments" className="space-y-1.5">
        {shown.map((item) => (
          <CommentCard key={`${item.file}:${item.comment.from}:${item.comment.body}`} item={item} title={titles.get(item.file) ?? item.file} />
        ))}
      </ul>
      {all.length === 0 && (
        <p className="text-[11px] text-faint">
          Select text and press {MOD}⌥C to comment on it. Comments stay in the Markdown, show up in the review PDF and are left
          out of the final PDF.
        </p>
      )}
    </div>
  );
}
