import { Focus, LoaderCircle, Maximize2, ScanText, ZoomIn, ZoomOut } from "lucide-react";
import {
  GlobalWorkerOptions,
  RenderingCancelledException,
  TextLayer,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { editorBridge } from "@/editor/bridge";
import { bestLineInParts } from "@/lib/parts";
import { usesChapters } from "@/lib/templates";
import { bestLine } from "@/lib/textmatch";
import { pdfPageIndex } from "@/lib/toc";
import { setPreviewFocus } from "@/session";
import { isPartFile, jumpTo, revealInPreview, store, useStore } from "@/store";
import { IconButton, MOD, cx } from "./ui";

// One worker for every document the session loads.
GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: "module" });

const PAGE_GAP = 16;
const PADDING = 24;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 4;

interface Size {
  w: number;
  h: number;
}

interface LoadedDoc {
  proxy: PDFDocumentProxy;
  task: PDFDocumentLoadingTask;
  sizes: Size[];
  version: number;
}

interface TextLine {
  page: number;
  text: string;
  /** Top of the line in PDF points from the top of the page. */
  top: number;
  height: number;
}

async function pageLines(proxy: PDFDocumentProxy, index: number, size: Size): Promise<TextLine[]> {
  const page = await proxy.getPage(index + 1);
  const content = await page.getTextContent();
  const rows = new Map<number, { text: string; height: number }>();
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const y = Math.round(item.transform[5]);
    const row = rows.get(y) ?? { text: "", height: item.height };
    row.text += (row.text ? " " : "") + item.str;
    row.height = Math.max(row.height, item.height);
    rows.set(y, row);
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, r]) => ({ page: index, text: r.text, top: size.h - y - r.height, height: r.height }));
}

function PageView({
  proxy,
  index,
  size,
  scale,
  version,
  root,
}: {
  proxy: PDFDocumentProxy;
  index: number;
  size: Size;
  scale: number;
  version: number;
  root: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const rendered = useRef<{ version: number; scale: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root,
      rootMargin: "1200px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!visible) return;
    const done = rendered.current;
    if (done && done.version === version && done.scale === scale) return;
    let cancelled = false;
    let renderTask: ReturnType<PDFPageProxy["render"]> | null = null;
    let textLayer: TextLayer | null = null;

    (async () => {
      const page = await proxy.getPage(index + 1);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      renderTask = page.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      await renderTask.promise;
      const host = ref.current;
      if (cancelled || !host) return;
      // Swap only once the new bitmap is ready, so recompiles never flash a blank page.
      host.querySelector("canvas")?.remove();
      host.prepend(canvas);

      const layer = document.createElement("div");
      layer.className = "textLayer";
      textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport });
      await textLayer.render();
      if (cancelled) return;
      host.querySelector(".textLayer")?.remove();
      host.appendChild(layer);
      rendered.current = { version, scale };
    })().catch((e) => {
      if (!(e instanceof RenderingCancelledException) && !cancelled) console.error(e);
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [visible, version, scale, proxy, index]);

  const style = {
    width: size.w * scale,
    height: size.h * scale,
    "--total-scale-factor": scale,
    "--scale-factor": scale,
    "--scale-round-x": "1px",
    "--scale-round-y": "1px",
  } as CSSProperties;
  return <div ref={ref} className="pf-page" data-page={index} style={style} />;
}

export function Preview() {
  const pdf = useStore((s) => s.pdf);
  const compileState = useStore((s) => s.compile.state);
  const hasErrors = useStore((s) => s.diagnostics.some((d) => d.severity === "error"));
  const scroller = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [doc, setDoc] = useState<LoadedDoc | null>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState<number | "fit">(() => {
    const saved = localStorage.getItem("paperforge.zoom");
    return saved && saved !== "fit" ? Number(saved) : "fit";
  });
  const [currentPage, setCurrentPage] = useState(1);
  const [reveal, setReveal] = useState<{ page: number; top: number; height: number; key: number } | null>(null);
  const linesCache = useRef<{ version: number; lines: Promise<TextLine[]>[] } | null>(null);
  const chapters = useStore((s) => usesChapters(s.meta?.template));
  const previewFocus = useStore((s) => s.previewFocus);

  useEffect(() => localStorage.setItem("paperforge.zoom", String(zoom)), [zoom]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Load each new PDF beside the current one and swap when its page sizes are known.
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    // The worker takes ownership of the buffer it is given, so hand it a copy.
    const task = getDocument({ data: pdf.data.slice(), enableXfa: false });
    task.promise
      .then(async (proxy) => {
        const sizes = await Promise.all(
          Array.from({ length: proxy.numPages }, async (_, i) => {
            const vp = (await proxy.getPage(i + 1)).getViewport({ scale: 1 });
            return { w: vp.width, h: vp.height };
          }),
        );
        if (cancelled) return void task.destroy();
        setDoc((previous) => {
          // Pages may still be painting from the old document for a moment.
          if (previous) setTimeout(() => void previous.task.destroy(), 3000);
          return { proxy, task, sizes, version: pdf.version };
        });
      })
      .catch((e) => !cancelled && console.error(e));
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  const maxWidth = useMemo(() => Math.max(1, ...(doc?.sizes.map((s) => s.w) ?? [612])), [doc]);
  const scale = zoom === "fit" ? Math.max(MIN_ZOOM, (width - PADDING * 2) / maxWidth) : zoom;

  // Keep the same spot of the document in view when the zoom changes.
  const lastScale = useRef(scale);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && lastScale.current !== scale) {
      el.scrollTop = (el.scrollTop / lastScale.current) * scale;
      lastScale.current = scale;
    }
  }, [scale]);

  function pageTops(): number[] {
    const tops: number[] = [];
    let y = PADDING;
    for (const s of doc?.sizes ?? []) {
      tops.push(y);
      y += s.h * scale + PAGE_GAP;
    }
    return tops;
  }

  function onScroll() {
    const el = scroller.current;
    if (!el || !doc) return;
    const middle = el.scrollTop + el.clientHeight / 3;
    const tops = pageTops();
    let page = 1;
    tops.forEach((t, i) => middle >= t && (page = i + 1));
    setCurrentPage(page);
  }

  function zoomBy(factor: number) {
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(scale * factor * 100) / 100)));
  }

  function onWheel(e: React.WheelEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }

  // Double-click in the PDF: find the clicked sentence in the Markdown source.
  function onDoubleClick(e: React.MouseEvent) {
    const span = (e.target as HTMLElement).closest(".textLayer span");
    if (!span) return;
    let text = span.textContent ?? "";
    for (let next = span.nextElementSibling; next && text.split(/\s+/).length < 14; next = next.nextElementSibling) {
      text += ` ${next.textContent ?? ""}`;
    }
    const clicked = window.getSelection()?.toString();
    const match = bestLineInParts(text, store.get().parts, clicked);
    if (match) jumpTo(match.file, match.line);
  }

  // Contents entry clicked: scroll to its printed page.
  useEffect(
    () =>
      useStore.subscribe(async (s, prev) => {
        const request = s.pageReveal;
        const el = scroller.current;
        if (!request || request === prev.pageReveal || !doc || !el) return;
        const labels = await doc.proxy.getPageLabels().catch(() => null);
        const index = pdfPageIndex(request.page, labels, doc.sizes.length);
        if (index === null) return;
        el.scrollTo({ top: pageTops()[index] - PADDING / 2, behavior: "smooth" });
      }),
    [doc, scale],
  );

  // Cursor -> PDF: scroll to the best-matching line of text and flash it.
  useEffect(
    () =>
      useStore.subscribe(async (s, prev) => {
        const request = s.previewReveal;
        if (!request || request === prev.previewReveal || !doc) return;
        if (linesCache.current?.version !== doc.version) {
          linesCache.current = {
            version: doc.version,
            lines: doc.sizes.map((size, i) => pageLines(doc.proxy, i, size)),
          };
        }
        const lines = (await Promise.all(linesCache.current.lines)).flat();
        const match = bestLine(request.text, lines.map((l) => l.text));
        const el = scroller.current;
        if (!match || !el) return;
        const line = lines[match.line];
        const top = pageTops()[line.page] + line.top * scale;
        el.scrollTo({ top: top - el.clientHeight / 3, behavior: "smooth" });
        setReveal({ page: line.page, top: line.top, height: line.height, key: request.nonce });
      }),
    [doc, scale],
  );

  function revealCursor() {
    const view = editorBridge.view;
    if (view && isPartFile(store.get().activeFile)) {
      revealInPreview(view.state.doc.lineAt(view.state.selection.main.head).text);
    }
  }

  const empty = !doc;
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--pf-preview-bg)]">
      <div className="@container flex h-9 shrink-0 items-center gap-1 whitespace-nowrap border-b border-line bg-panel px-2">
        <span className="px-1 text-xs tabular-nums text-muted">
          {doc ? `Page ${currentPage} of ${doc.sizes.length}` : "Preview"}
        </span>
        {compileState === "running" && <LoaderCircle size={14} className="animate-spin text-accent" aria-label="Compiling" />}
        <div className="flex-1" />
        {chapters && (
          <button
            type="button"
            aria-pressed={previewFocus}
            aria-label="Current chapter only"
            onClick={() => setPreviewFocus(!previewFocus)}
            title="Preview: typeset only the chapter you are editing (faster on long documents). Typeset builds everything."
            className={cx(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors cursor-default",
              previewFocus ? "bg-accent-soft text-accent" : "text-muted hover:bg-raised hover:text-fg",
            )}
          >
            <Focus size={14} />
            <span className="hidden @min-[30rem]:inline">Current chapter only</span>
          </button>
        )}
        <IconButton label="Show cursor position in PDF" onClick={revealCursor} disabled={empty}>
          <ScanText size={15} />
        </IconButton>
        <IconButton label="Zoom out" shortcut={`${MOD}-wheel`} onClick={() => zoomBy(1 / 1.15)} disabled={empty}>
          <ZoomOut size={15} />
        </IconButton>
        <button
          className="h-7 min-w-12 rounded-md px-1 text-xs tabular-nums text-muted hover:bg-raised cursor-default"
          onClick={() => setZoom(1)}
          title="Actual size"
        >
          {Math.round(scale * 100)}%
        </button>
        <IconButton label="Zoom in" onClick={() => zoomBy(1.15)} disabled={empty}>
          <ZoomIn size={15} />
        </IconButton>
        <IconButton label="Fit width" active={zoom === "fit"} onClick={() => setZoom("fit")} disabled={empty}>
          <Maximize2 size={14} />
        </IconButton>
      </div>
      <div
        ref={(el) => {
          scroller.current = el;
          setRoot(el);
        }}
        className="relative min-h-0 flex-1 overflow-auto"
        style={{ padding: PADDING }}
        onScroll={onScroll}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        title="Double-click text to jump to its source"
      >
        {doc?.sizes.map((size, i) => (
          <div key={i} className="relative" style={{ marginBottom: PAGE_GAP }}>
            <PageView proxy={doc.proxy} index={i} size={size} scale={scale} version={doc.version} root={root} />
            {reveal?.page === i && (
              <div
                key={reveal.key}
                className="pf-reveal mx-auto"
                style={{ top: reveal.top * scale - 2, height: reveal.height * scale + 4, width: size.w * scale }}
              />
            )}
          </div>
        ))}
        {empty && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
            {compileState === "error" || hasErrors ? (
              <p className="max-w-xs text-center text-sm">The paper did not compile. Open the problems panel to see why.</p>
            ) : (
              <>
                <LoaderCircle className="animate-spin text-accent" />
                <p className="text-sm">Typesetting your paper…</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
