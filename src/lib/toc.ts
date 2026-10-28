import type { TocEntry } from "./api";

export interface TocLists {
  toc: TocEntry[];
  lof: TocEntry[];
  lot: TocEntry[];
}

export function tocLists(entries: TocEntry[]): TocLists {
  const out: TocLists = { toc: [], lof: [], lot: [] };
  for (const e of entries) out[e.list]?.push(e);
  return out;
}

/** Indentation steps of each entry, relative to the shallowest one in its list. */
export function tocIndents(entries: TocEntry[]): number[] {
  const min = Math.min(...entries.map((e) => e.depth));
  return entries.map((e) => Math.max(0, e.depth - min));
}

/** An arabic page number; null for roman (front matter) or anything else LaTeX may print. */
export function arabicPage(page: string): number | null {
  return /^\d+$/.test(page.trim()) ? Number(page.trim()) : null;
}

/** 0-based PDF page for a printed page number, using the PDF's page labels when it has them. */
export function pdfPageIndex(page: number, labels: string[] | null, pageCount: number): number | null {
  if (labels) {
    const at = labels.indexOf(String(page));
    if (at >= 0) return at;
  }
  return page >= 1 && page <= pageCount ? page - 1 : null;
}
