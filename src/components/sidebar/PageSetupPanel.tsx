import { useEffect, useState } from "react";
import type { Layout, LineSpacing, MainFont, MarginUnit, Margins, Slots } from "@/lib/api";
import {
  FONT_SIZES,
  MAX_MARGIN,
  PAPERS,
  classOption,
  clampMargin,
  convertMargins,
  isUniform,
  layoutOf,
  toMm,
  withClassOption,
  type OptionKind,
} from "@/lib/pageSetup";
import { templateInfo } from "@/lib/templates";
import { updateMeta } from "@/session";
import { useStore } from "@/store";
import { Checkbox, Input, Select } from "../ui";

const SPACINGS: { id: LineSpacing; label: string; factor: number }[] = [
  { id: "single", label: "Single", factor: 1 },
  { id: "onehalf", label: "1.5 lines", factor: 1.5 },
  { id: "double", label: "Double", factor: 2 },
];

/** Only fonts in the offline TeX cache. */
const FONTS: { id: MainFont; label: string }[] = [
  { id: "latinModern", label: "Latin Modern" },
  { id: "termes", label: "Times (TeX Gyre Termes)" },
  { id: "libertine", label: "Linux Libertine" },
];

const UNITS: MarginUnit[] = ["cm", "mm", "in"];

function Heading({ children }: { children: string }) {
  return <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">{children}</h3>;
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] text-muted">{label}</span>
      {children}
    </label>
  );
}

/** Word's "Page setup": paper, margins, spacing, font, header and footer of the generic templates. */
export function PageSetupPanel() {
  const meta = useStore((s) => s.meta)!;
  const info = templateInfo(meta.template);
  return (
    <section aria-labelledby="pf-page-heading" className="space-y-3">
      <h3 id="pf-page-heading" className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        Page setup
      </h3>
      {info.page ? (
        <PageSetupFields />
      ) : (
        <p className="text-[12px] leading-snug text-muted">
          Set by the journal: the {info.label} template fixes the paper, margins, fonts, headers and footers.
        </p>
      )}
    </section>
  );
}

function PageSetupFields() {
  const meta = useStore((s) => s.meta)!;
  const page = templateInfo(meta.template).page!;
  const layout = layoutOf(meta.layout);
  const options = meta.classOptions ?? [];
  const defaults: Record<OptionKind, string> = { paper: page.paper, size: page.fontSize, columns: "onecolumn" };
  const option = (kind: OptionKind) => classOption(options, kind, defaults[kind]);
  const setOption = (kind: OptionKind, value: string) =>
    updateMeta({ classOptions: withClassOption(options, kind, value, defaults[kind]) });
  const setLayout = (patch: Partial<Layout>) => updateMeta({ layout: { ...layout, ...patch } });
  const paper = PAPERS.find((p) => p.option === option("paper"));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <Labeled label="Paper">
          <Select className="w-full" value={option("paper")} onChange={(e) => setOption("paper", e.target.value)}>
            {!paper && <option value={option("paper")}>{option("paper")}</option>}
            {PAPERS.map((p) => (
              <option key={p.option} value={p.option}>
                {p.label}
              </option>
            ))}
          </Select>
        </Labeled>
        <Labeled label="Font size">
          <Select className="w-full" value={option("size")} onChange={(e) => setOption("size", e.target.value)}>
            {!FONT_SIZES.includes(option("size") as never) && <option value={option("size")}>{option("size")}</option>}
            {FONT_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Labeled>
        <Labeled label="Columns">
          <Select className="w-full" value={option("columns")} onChange={(e) => setOption("columns", e.target.value)}>
            <option value="onecolumn">One</option>
            <option value="twocolumn">Two</option>
          </Select>
        </Labeled>
      </div>

      <MarginsEditor
        margins={layout.margins}
        twoside={page.twoside}
        onChange={(margins) => setLayout({ margins })}
        diagram={
          <PageDiagram
            size={paper?.size ?? [210, 297]}
            layout={layout}
            columns={option("columns") === "twocolumn" ? 2 : 1}
            fontPt={parseFloat(option("size")) || 11}
          />
        }
      />

      <div className="grid grid-cols-2 gap-2">
        <Labeled label="Line spacing">
          <Select
            className="w-full"
            value={layout.lineSpacing}
            onChange={(e) => setLayout({ lineSpacing: e.target.value as LineSpacing })}
          >
            {SPACINGS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        </Labeled>
        <Labeled label="Font">
          <Select className="w-full" value={layout.font} onChange={(e) => setLayout({ font: e.target.value as MainFont })}>
            {FONTS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
        </Labeled>
      </div>

      <SlotsEditor name="Header" slots={layout.header} onChange={(header) => setLayout({ header })} />
      <SlotsEditor name="Footer" slots={layout.footer} onChange={(footer) => setLayout({ footer })} />
      <p className="-mt-2 text-[11px] leading-snug text-faint">
        Type {"{page}"} for the page number. An empty footer keeps the centered page number; chapter and title pages show
        the footer only.
      </p>

      <Checkbox
        checked={layout.lineNumbers}
        onChange={(lineNumbers) => setLayout({ lineNumbers })}
        label="Line numbers"
        hint="In the margin, for review copies"
      />
      {meta.templateFile && (
        <p className="text-[11px] leading-snug text-faint">
          Your template copy only follows these settings where it uses <code className="font-mono">$geometry$</code> and{" "}
          <code className="font-mono">$page-setup$</code>.
        </p>
      )}
    </div>
  );
}

function MarginsEditor({
  margins,
  twoside,
  onChange,
  diagram,
}: {
  margins: Margins;
  twoside: boolean;
  onChange: (m: Margins) => void;
  diagram: React.ReactNode;
}) {
  const [separate, setSeparate] = useState(!isUniform(margins));
  const { unit } = margins;
  const side = (key: "top" | "bottom" | "left" | "right", label: string) => (
    <MarginInput key={key} label={label} unit={unit} value={margins[key]} onChange={(v) => onChange({ ...margins, [key]: v })} />
  );
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Heading>Margins</Heading>
        <Select
          aria-label="Margin unit"
          className="h-7 w-16 text-xs"
          value={unit}
          onChange={(e) => onChange(convertMargins(margins, e.target.value as MarginUnit))}
        >
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex items-start gap-3">
        {diagram}
        <div className="min-w-0 flex-1 space-y-1.5">
          {separate ? (
            <>
              {side("top", "Top")}
              {side("bottom", "Bottom")}
              {side("left", twoside ? "Inner" : "Left")}
              {side("right", twoside ? "Outer" : "Right")}
            </>
          ) : (
            <MarginInput
              label="All"
              unit={unit}
              value={margins.top}
              onChange={(v) => onChange({ unit, top: v, bottom: v, left: v, right: v })}
            />
          )}
          <Checkbox
            checked={!separate}
            onChange={(same) => {
              setSeparate(!same);
              if (same) onChange({ unit, top: margins.top, bottom: margins.top, left: margins.top, right: margins.top });
            }}
            label="Same on all sides"
          />
        </div>
      </div>
    </div>
  );
}

/** Keeps the typed text (an empty field, "2.") while it is not a number yet. */
function MarginInput({
  label,
  unit,
  value,
  onChange,
}: {
  label: string;
  unit: MarginUnit;
  value: number;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText((t) => (Number(t) === value && t.trim() !== "" ? t : String(value))), [value]);
  return (
    <label className="flex items-center gap-1.5">
      <span className="w-12 shrink-0 text-[12px] text-muted">{label}</span>
      <Input
        type="number"
        inputMode="decimal"
        aria-label={`${label} margin`}
        min={0}
        max={MAX_MARGIN[unit]}
        step={unit === "mm" ? 1 : 0.1}
        className="h-7 min-w-0 text-right font-mono text-xs"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const v = e.target.valueAsNumber;
          if (Number.isFinite(v)) onChange(clampMargin(v, unit));
        }}
        onBlur={() => setText(String(value))}
      />
      <span className="w-4 shrink-0 text-[11px] text-faint">{unit}</span>
    </label>
  );
}

function SlotsEditor({ name, slots, onChange }: { name: string; slots: Slots; onChange: (s: Slots) => void }) {
  return (
    <div className="space-y-1">
      <span className="text-[12px] text-muted">{name}</span>
      <div className="grid grid-cols-3 gap-1.5">
        {(["left", "center", "right"] as const).map((at) => (
          <Input
            key={at}
            aria-label={`${name} ${at}`}
            placeholder={at[0].toUpperCase() + at.slice(1)}
            className={`h-7 text-xs ${at === "center" ? "text-center" : at === "right" ? "text-right" : ""}`}
            value={slots[at]}
            onChange={(e) => onChange({ ...slots, [at]: e.target.value })}
          />
        ))}
      </div>
    </div>
  );
}

const PT_MM = 25.4 / 72.27;
const COLUMN_GAP_MM = 6;

/** The sheet at scale with its text area, columns, line pitch, header and footer. */
function PageDiagram({
  size: [width, height],
  layout,
  columns,
  fontPt,
}: {
  size: readonly [number, number];
  layout: Layout;
  columns: 1 | 2;
  fontPt: number;
}) {
  const m = layout.margins;
  const mm = (v: number) => toMm(v, m.unit);
  const left = Math.min(mm(m.left), width / 2 - 1);
  const right = Math.min(mm(m.right), width / 2 - 1);
  const top = Math.min(mm(m.top), height / 2 - 1);
  const bottom = Math.min(mm(m.bottom), height / 2 - 1);
  const textWidth = width - left - right;
  const textHeight = height - top - bottom;
  const factor = SPACINGS.find((s) => s.id === layout.lineSpacing)?.factor ?? 1;
  const pitch = fontPt * 1.2 * factor * PT_MM;
  const columnWidth = columns === 2 ? (textWidth - COLUMN_GAP_MM) / 2 : textWidth;
  const lines = Math.max(0, Math.floor(textHeight / pitch));
  const filled = (s: Slots) => [s.left, s.center, s.right].some((t) => t.trim());
  const scale = 132 / height;

  return (
    <svg
      role="img"
      aria-label={`Page diagram, ${Math.round(width)} by ${Math.round(height)} mm`}
      viewBox={`0 0 ${width} ${height}`}
      width={width * scale}
      height={132}
      className="shrink-0 text-muted"
    >
      <rect x={0} y={0} width={width} height={height} className="fill-panel stroke-line" strokeWidth={1.5} />
      <rect
        x={left}
        y={top}
        width={textWidth}
        height={textHeight}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.5}
        strokeDasharray="3 2"
        strokeWidth={0.8}
      />
      {Array.from({ length: columns }, (_, c) =>
        Array.from({ length: lines }, (_, i) => {
          const x = left + c * (columnWidth + COLUMN_GAP_MM);
          const y = top + (i + 0.75) * pitch;
          const w = i % 7 === 6 ? columnWidth * 0.6 : columnWidth;
          return <line key={`${c}-${i}`} x1={x} x2={x + w} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.3} strokeWidth={0.9} />;
        }),
      )}
      {layout.lineNumbers &&
        Array.from({ length: Math.ceil(lines / 5) }, (_, i) => (
          <circle key={i} cx={left - 3} cy={top + (i * 5 + 0.75) * pitch} r={0.7} className="fill-accent" />
        ))}
      {filled(layout.header) && <SlotBar slots={layout.header} x={left} y={top / 2} width={textWidth} />}
      <SlotBar
        slots={filled(layout.footer) ? layout.footer : { left: "", center: "{page}", right: "" }}
        x={left}
        y={height - bottom / 2}
        width={textWidth}
      />
    </svg>
  );
}

function SlotBar({ slots, x, y, width }: { slots: Slots; x: number; y: number; width: number }) {
  const bar = 0.22 * width;
  const at = { left: x, center: x + (width - bar) / 2, right: x + width - bar };
  return (
    <>
      {(["left", "center", "right"] as const)
        .filter((k) => slots[k].trim())
        .map((k) => (
          <rect key={k} x={at[k]} y={y - 1} width={bar} height={2} rx={1} className="fill-accent" fillOpacity={0.7} />
        ))}
    </>
  );
}
