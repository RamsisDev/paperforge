import {
  forwardRef,
  useEffect,
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
  icon?: ReactNode;
  shortcut?: string;
  onSelect: () => void;
  disabled?: boolean;
}

export function Menu({ trigger, items, align = "end" }: { trigger: ReactNode; items: MenuItem[]; align?: "start" | "end" }) {
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
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div
          role="menu"
          className={cx(
            "absolute top-full z-50 mt-1 min-w-52 rounded-lg border border-line bg-panel p-1 shadow-xl",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-fg hover:bg-raised disabled:opacity-40 cursor-default"
            >
              <span className="text-muted">{item.icon}</span>
              <span className="flex-1">{item.label}</span>
              {item.shortcut && <Kbd>{item.shortcut}</Kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { id: T; label: string; icon?: ReactNode; badge?: ReactNode }[];
  className?: string;
}) {
  return (
    <div role="tablist" className={cx("flex items-center gap-0.5", className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          title={t.label}
          className={cx(
            "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors cursor-default",
            value === t.id ? "bg-raised text-fg" : "text-muted hover:text-fg",
          )}
        >
          {t.icon}
          <span>{t.label}</span>
          {t.badge}
        </button>
      ))}
    </div>
  );
}

export const isMac = navigator.platform.toLowerCase().includes("mac") || navigator.userAgent.includes("Mac OS");
export const MOD = isMac ? "⌘" : "Ctrl+";
export const SHIFT = isMac ? "⇧" : "Shift+";
