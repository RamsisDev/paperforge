import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90 shadow-sm",
  secondary: "bg-panel text-fg border border-line hover:bg-raised",
  ghost: "text-muted hover:bg-raised hover:text-fg",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }
>(function Button({ variant = "secondary", size = "md", className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors",
        "disabled:opacity-50 disabled:pointer-events-none cursor-default",
        "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  );
});

export function IconButton({
  label,
  shortcut,
  active,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; shortcut?: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={cx(
        "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors cursor-default",
        "text-muted hover:bg-raised hover:text-fg disabled:opacity-40 disabled:pointer-events-none",
        "focus-visible:outline-2 focus-visible:outline-accent",
        active && "bg-raised text-fg",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

const FIELD =
  "rounded-md border border-line bg-panel px-2.5 text-[13px] text-fg placeholder:text-faint " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-shadow";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx(FIELD, "h-8 w-full", className)} {...rest} />;
  },
);

/** Grows with its content up to `maxRows`. */
export function Textarea({
  className,
  maxRows = 14,
  value,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { maxRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight + 2, line * maxRows + 16)}px`;
  };
  useEffect(fit, [value, maxRows]);
  // Panels get their width after mount and on every drag of a separator.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <textarea ref={ref} value={value} rows={1} className={cx(FIELD, "w-full py-1.5 leading-5 resize-none", className)} {...rest} />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(FIELD, "h-8 pr-7 appearance-none bg-no-repeat cursor-default", className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
        backgroundPosition: "right 8px center",
      }}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="flex items-baseline justify-between text-[11px] font-semibold uppercase tracking-wide text-muted">
        {label}
        {hint && <span className="font-normal normal-case tracking-normal text-faint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-raised px-1 py-px font-mono text-[10px] text-muted">{children}</kbd>
  );
}

export interface MenuItem {
  label: string;
  /** Needed when two items share a label. */
  key?: string;
  icon?: ReactNode;
  shortcut?: string;
  /** Secondary text at the right, such as the current value. */
  hint?: string;
  active?: boolean;
  onSelect: () => void;
  disabled?: boolean;
}

export const MENU_SEPARATOR = "-";

export function Menu({
  trigger,
  items,
  align = "end",
  className,
}: {
  trigger: ReactNode;
  items: (MenuItem | typeof MENU_SEPARATOR)[];
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={ref} className={cx("relative", className)}>
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div
          role="menu"
          className={cx(
            "absolute top-full z-50 mt-1 max-h-[70vh] w-max min-w-52 max-w-80 overflow-auto rounded-lg border border-line bg-panel p-1 shadow-xl",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {items.map((item, i) =>
            item === MENU_SEPARATOR ? (
              <div key={`sep-${i}`} role="separator" className="mx-1 my-1 h-px bg-line" />
            ) : (
              <button
                key={item.key ?? item.label}
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={cx(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-raised disabled:opacity-40 cursor-default",
                  item.active ? "bg-accent-soft text-accent" : "text-fg",
                )}
              >
                {item.icon && <span className="shrink-0 text-muted">{item.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint && <span className="shrink-0 text-[11px] text-faint">{item.hint}</span>}
                {item.shortcut && <Kbd>{item.shortcut}</Kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="flex items-start gap-2 py-0.5 text-[13px] text-fg cursor-default">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--pf-accent)]"
      />
      <span>
        {label}
        {hint && <span className="block text-[11px] text-faint">{hint}</span>}
      </span>
    </label>
  );
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';

/** Modal dialog: Esc and a click on the backdrop close it, Tab stays inside. */
export function Dialog({
  title,
  onClose,
  children,
  className,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("[data-autofocus]") ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => previous?.focus?.();
  }, []);
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab" && ref.current) {
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && at <= 0) {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (!e.shiftKey && at === items.length - 1) {
        e.preventDefault();
        items[0].focus();
      }
    }
  }
  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className={cx("flex max-h-full w-full flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl", className)}
      >
        <h2 id={titleId} className="shrink-0 px-5 pt-4 text-[15px] font-semibold text-fg">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  className,
  compact,
}: {
  value: T;
  onChange: (v: T) => void;
  /** `truncate`: the tab shrinks, ellipsizing its label, when the bar is short of room. */
  tabs: { id: T; label: string; icon?: ReactNode; badge?: ReactNode; truncate?: boolean }[];
  className?: string;
  /** In a narrow bar, inactive tabs show only their icon. */
  compact?: boolean;
}) {
  return (
    <div role="tablist" className={cx("flex items-center gap-0.5", compact && "@container", className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          aria-label={t.label}
          onClick={() => onChange(t.id)}
          title={t.label}
          className={cx(
            "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors cursor-default",
            t.truncate ? "min-w-0" : "shrink-0",
            value === t.id ? "bg-raised text-fg" : "text-muted hover:text-fg",
          )}
        >
          {t.icon && <span className="shrink-0">{t.icon}</span>}
          <span className={cx("truncate", compact && value !== t.id && "@max-[19.25rem]:hidden")}>{t.label}</span>
          {t.badge}
        </button>
      ))}
    </div>
  );
}

export const isMac = navigator.platform.toLowerCase().includes("mac") || navigator.userAgent.includes("Mac OS");
export const MOD = isMac ? "⌘" : "Ctrl+";
export const SHIFT = isMac ? "⇧" : "Shift+";
