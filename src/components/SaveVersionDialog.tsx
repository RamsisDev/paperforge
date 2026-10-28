import { useState, type FormEvent } from "react";
import { saveVersion } from "@/history";
import { store, useStore } from "@/store";
import { notify } from "./Toaster";
import { Button, Dialog, Field, Input, MOD, Textarea } from "./ui";

function SaveVersionDialog() {
  const enabled = useStore((s) => s.historyStatus?.enabled === true);
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const close = () => store.set({ versionDialog: false });

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await saveVersion(label.trim(), note.trim());
      close();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
      setBusy(false);
    }
  }

  return (
    <Dialog title="Save version" onClose={close} className="max-w-sm">
      <form
        onSubmit={submit}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void submit()}
        className="space-y-3 px-5 pb-4 pt-2"
      >
        <p className="text-[12px] leading-snug text-muted">
          {enabled
            ? "Keeps the paper as it is now. A name turns it into a milestone that is easy to find again."
            : "Turns on version history for this project and keeps the paper as it is now."}
        </p>
        <Field label="Name" hint="optional">
          <Input data-autofocus placeholder="e.g. Sent to reviewer" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Note" hint="optional">
          <Textarea maxRows={5} placeholder="What changed, who it went to…" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy} title={`${MOD}Enter`}>
            Save version
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Mounted once in the workspace; subscribes on its own so opening it re-renders nothing else. */
export function SaveVersionHost() {
  const open = useStore((s) => s.versionDialog);
  return open ? <SaveVersionDialog /> : null;
}
