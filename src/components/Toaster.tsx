import { CircleAlert, CircleCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cx } from "./ui";

interface Toast {
  id: number;
  kind: "ok" | "error";
  message: string;
}

let listeners: ((t: Toast[]) => void)[] = [];
let toasts: Toast[] = [];
let next = 0;

function emit() {
  for (const l of listeners) l(toasts);
}

export function notify(message: string, kind: Toast["kind"] = "ok") {
  const toast = { id: ++next, kind, message };
  toasts = [...toasts, toast].slice(-4);
  emit();
  setTimeout(() => dismiss(toast.id), kind === "error" ? 8000 : 3500);
}

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function Toaster() {
  const [items, setItems] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.push(setItems);
    return () => {
      listeners = listeners.filter((l) => l !== setItems);
    };
  }, []);
  return (
    <div className="pointer-events-none fixed bottom-10 right-4 z-[100] flex w-96 flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className="pointer-events-auto flex items-start gap-2 rounded-lg border border-line bg-panel p-3 text-[13px] shadow-xl"
        >
          {t.kind === "ok" ? (
            <CircleCheck size={16} className="mt-px shrink-0 text-ok" />
          ) : (
            <CircleAlert size={16} className="mt-px shrink-0 text-danger" />
          )}
          <p className={cx("flex-1 break-words", t.kind === "error" && "select-text")}>{t.message}</p>
          <button onClick={() => dismiss(t.id)} className="text-faint hover:text-fg" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
