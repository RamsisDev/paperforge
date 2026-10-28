import { EditorView, WidgetType } from "@codemirror/view";
import katex from "katex";
import { api, joinPath } from "@/lib/api";
import { parseBib, type BibEntry } from "@/lib/bib";
import { store } from "@/store";

let bibCache: { source: string; entries: Map<string, BibEntry> } = { source: "", entries: new Map() };

export function bibEntry(key: string): BibEntry | undefined {
  const source = store.get().bib;
  if (source !== bibCache.source) bibCache = { source, entries: new Map(parseBib(source).map((e) => [e.key, e])) };
  return bibCache.entries.get(key);
}

/**
 * A widget standing in for source text. A click puts the cursor `cursorOffset` characters into
 * that source, which shows it again; subclasses only build the DOM.
 */
export abstract class SourceWidget extends WidgetType {
  constructor(readonly cursorOffset = 0) {
    super();
  }

  abstract render(view: EditorView): HTMLElement;

  toDOM(view: EditorView): HTMLElement {
    const dom = this.render(view);
    dom.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const pos = Math.min(view.posAtDOM(dom) + this.cursorOffset, view.state.doc.length);
      view.dispatch({ selection: { anchor: pos }, userEvent: "select.pointer" });
      view.focus();
    });
    return dom;
  }

  ignoreEvent() {
    return true;
  }
}

const katexCache = new Map<string, string>();

function renderTex(tex: string, display: boolean): string {
  const key = `${display ? "D" : "I"}${tex}`;
  let html = katexCache.get(key);
  if (html === undefined) {
    html = katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "html" });
    if (katexCache.size > 500) katexCache.clear();
    katexCache.set(key, html);
  }
  return html;
}

export class MathWidget extends SourceWidget {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    /** "(2.1)" for a numbered equation, a label before the first compile, or "". */
    readonly tag = "",
  ) {
    super(display ? 2 : 1);
  }
  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display && other.tag === this.tag;
  }
  render() {
    const dom = document.createElement("span");
    dom.className = this.display ? "pf-lp-math pf-lp-math-display" : "pf-lp-math";
    dom.innerHTML = renderTex(this.tex, this.display);
    if (this.tag) {
      const tag = dom.appendChild(document.createElement("span"));
      tag.className = "pf-lp-eqno";
      tag.textContent = this.tag;
    }
    return dom;
  }
  get estimatedHeight() {
    return this.display ? 48 : -1;
  }
}

/** A short label in place of a citation, reference, footnote or attribute block. */
export class ChipWidget extends SourceWidget {
  constructor(
    readonly text: string,
    readonly kind: string,
    readonly title = "",
    cursorOffset = 1,
  ) {
    super(cursorOffset);
  }
  eq(other: ChipWidget) {
    return other.text === this.text && other.kind === this.kind && other.title === this.title;
  }
  render() {
    const dom = document.createElement("span");
    dom.className = `pf-lp-chip pf-lp-${this.kind}`;
    dom.textContent = this.text;
    if (this.title) dom.title = this.title;
    return dom;
  }
}

/** The label of a fenced block (raw LaTeX, a div) on its opening fence line. */
export class FenceLabelWidget extends SourceWidget {
  constructor(
    readonly text: string,
    readonly kind: string,
  ) {
    super(0);
  }
  eq(other: FenceLabelWidget) {
    return other.text === this.text && other.kind === this.kind;
  }
  render() {
    const dom = document.createElement("span");
    dom.className = `pf-lp-fence pf-lp-fence-${this.kind}`;
    dom.textContent = this.text;
    return dom;
  }
}

const imageUrls = new Map<string, Promise<string>>();

/** An object URL for a project image, read once through the same command as the Figures tab. */
function imageUrl(dir: string, src: string): Promise<string> {
  const path = joinPath(dir, src);
  let url = imageUrls.get(path);
  if (!url) {
    url = api.readBinary(path).then((bytes) => URL.createObjectURL(new Blob([bytes])));
    url.catch(() => imageUrls.delete(path));
    imageUrls.set(path, url);
  }
  return url;
}

/** Drops the cached images, e.g. when the figures on disk changed. */
export function forgetImages() {
  for (const url of imageUrls.values()) url.then(URL.revokeObjectURL, () => {});
  imageUrls.clear();
}

export class FigureWidget extends SourceWidget {
  constructor(
    readonly src: string,
    readonly caption: string,
    /** Width as a CSS length (`80%`), or "". */
    readonly width: string,
    readonly dir: string,
    /** Whether the project's figure list has the file; others are not read. */
    readonly listed: boolean,
  ) {
    super(0);
  }
  eq(other: FigureWidget) {
    return (
      other.src === this.src &&
      other.caption === this.caption &&
      other.width === this.width &&
      other.dir === this.dir &&
      other.listed === this.listed
    );
  }
  render(view: EditorView) {
    const dom = document.createElement("span");
    dom.className = "pf-lp-figure";
    const frame = dom.appendChild(document.createElement("span"));
    frame.className = "pf-lp-figure-frame";
    if (/^\d+(\.\d+)?%$/.test(this.width)) frame.style.width = this.width;
    if (/\.pdf$/i.test(this.src) || !this.dir || !this.listed) {
      frame.classList.add("pf-lp-figure-missing");
      frame.textContent = this.listed ? this.src : `Missing: ${this.src}`;
    } else {
      const img = frame.appendChild(document.createElement("img"));
      img.alt = this.caption;
      img.decoding = "async";
      const missing = () => {
        frame.classList.add("pf-lp-figure-missing");
        frame.textContent = `Missing: ${this.src}`;
        view.requestMeasure();
      };
      img.onload = () => view.requestMeasure();
      img.onerror = missing;
      imageUrl(this.dir, this.src).then((url) => (img.src = url), missing);
    }
    if (this.caption) {
      const caption = dom.appendChild(document.createElement("span"));
      caption.className = "pf-lp-caption";
      caption.textContent = this.caption;
    }
    return dom;
  }
  get estimatedHeight() {
    return 220;
  }
}
