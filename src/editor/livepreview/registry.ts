import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, type WidgetType } from "@codemirror/view";
import type { InlineKind, InlineToken } from "./syntax";

/** A top-level block of the Markdown syntax tree (`Table`, `Paragraph`, `FencedCode`…). */
export interface PreviewBlock {
  name: string;
  from: number;
  to: number;
  state: EditorState;
}

/**
 * Decorates one top-level block in Writing mode. Return null to leave the block to the built-in
 * rendering, or the decorations that replace it (an empty array leaves the block as source).
 * Decorations may span lines and must stay inside `block.from`..`block.to`; build them with
 * `previewReplace` so they give way to the source while the cursor is on them.
 */
export interface BlockWidgetProvider {
  /** Syntax node names this provider looks at; every block when omitted. */
  nodes?: readonly string[];
  decorate(block: PreviewBlock): Range<Decoration>[] | null;
}

/** The widget for one inline token, or null for the built-in one. */
export type InlineWidgetFactory<K extends InlineKind = InlineKind> = (
  token: Extract<InlineToken, { kind: K }>,
  state: EditorState,
) => WidgetType | null;

const blockProviders: BlockWidgetProvider[] = [];
const inlineFactories = new Map<InlineKind, InlineWidgetFactory[]>();
const extensions: Extension[] = [];

/** Registers a block renderer; later registrations are asked first. Call at module load. */
export function registerBlockWidget(provider: BlockWidgetProvider) {
  blockProviders.unshift(provider);
}

/** Overrides the widget for an inline kind (`math`, `cite`, `ref`…); later registrations win. */
export function registerInlineWidget<K extends InlineKind>(kind: K, factory: InlineWidgetFactory<K>) {
  inlineFactories.set(kind, [factory as unknown as InlineWidgetFactory, ...(inlineFactories.get(kind) ?? [])]);
}

/**
 * Adds an extension (popover, keymap, tooltip) that is active only in Writing mode. Registrations
 * must happen before the first editor state is created.
 */
export function registerWritingExtension(extension: Extension) {
  extensions.push(extension);
}

export function blockDecorations(block: PreviewBlock): Range<Decoration>[] | null {
  for (const p of blockProviders) {
    if (p.nodes && !p.nodes.includes(block.name)) continue;
    const decorations = p.decorate(block);
    if (decorations) return decorations;
  }
  return null;
}

export function inlineWidget(token: InlineToken, state: EditorState): WidgetType | null {
  for (const factory of inlineFactories.get(token.kind) ?? []) {
    const widget = factory(token, state);
    if (widget) return widget;
  }
  return null;
}

export function writingExtensions(): readonly Extension[] {
  return extensions;
}

/** Marks decorations that hide source: they are dropped on the lines the cursor or selection touch. */
export const REVEAL = "pfReveal";

/** Replaces `from`..`to` by `widget` (or hides it) outside the cursor's lines. */
export function previewReplace(from: number, to: number, widget?: WidgetType): Range<Decoration> {
  return Decoration.replace({ widget, [REVEAL]: true }).range(from, to);
}
