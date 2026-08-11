import type { Book, OutlineNode } from "../pdf/book";

/**
 * The smallest slice of a book the ingest will ever address: the run of pages
 * from one outline node's start to the next node's start.
 *
 * Segments never split a page, so a page's prose is attributed to whichever
 * node opened it. A parent node with children produces a segment of its own —
 * the introductory text sitting above its first subsection.
 */
export interface Segment {
  title: string;
  depth: number;
  /** 1-based PDF pages, inclusive. */
  from: number;
  to: number;
  prose: number;
  code: number;
}

/** A chapter: the segments under one chapter-level outline node. */
export interface Chapter {
  title: string;
  segments: Segment[];
}

/**
 * Titles that open a chapter. Books disagree on punctuation — DDIA writes
 * "Chapter 1. Reliable…", Clean Code writes "Chapter 1: Clean Code" — and some
 * books don't say "chapter" at all, which is what the depth fallback is for.
 */
export const CHAPTER_TITLE = /^(chapter|part|appendix)\b|^\d+\s*[.:—-]\s+\S/i;

/**
 * Titles that are not the book teaching you anything: the apparatus around the
 * text. Used two ways — to drop a segment from the syllabus, and to find where
 * a book's body stops so the passage corpus can stop with it.
 */
export const NON_TEACHING =
  /^(contents?|table of contents|index|colophon|copyright|about the author|dedication|acknowledg|bibliograph|references?|further reading|glossary|preface|foreword)\b/i;

export function segment(book: Book): Segment[] {
  const nodes = dedupeByPage(book.outline);

  return nodes.map((node, i) => {
    const from = node.page;
    // A node runs until the next node starts. The last one runs to the end of
    // the book, which sweeps up the index and back matter — filtered later.
    const to = (nodes[i + 1]?.page ?? book.pageCount + 1) - 1;
    return {
      title: node.title,
      depth: node.depth,
      from,
      to,
      prose: book.proseIn(from, to),
      code: book.codeIn(from, to),
    };
  });
}

/**
 * Group segments into chapters. Falls back to the shallowest outline depth when
 * no title looks like a chapter heading, so books that name their chapters
 * "Nouns and Verbs" still get grouped rather than collapsing into one.
 */
export function chapters(segments: Segment[]): Chapter[] {
  const named = segments.filter((s) => CHAPTER_TITLE.test(s.title));
  const isBoundary =
    named.length >= 3
      ? (s: Segment) => CHAPTER_TITLE.test(s.title)
      : boundaryAtShallowestDepth(segments);

  const out: Chapter[] = [];
  for (const s of segments) {
    if (isBoundary(s) || out.length === 0) {
      out.push({ title: isBoundary(s) ? s.title : "Front matter", segments: [] });
    }
    out[out.length - 1].segments.push(s);
  }
  return out;
}

function boundaryAtShallowestDepth(segments: Segment[]) {
  const shallowest = Math.min(...segments.map((s) => s.depth));
  return (s: Segment) => s.depth === shallowest;
}

/**
 * Two outline nodes can point at the same page — a section and its first
 * subsection usually do. Keep the shallowest, since it carries the better title,
 * and drop the rest so no segment is zero pages long.
 */
function dedupeByPage(nodes: OutlineNode[]): OutlineNode[] {
  const out: OutlineNode[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (last?.page === node.page) continue;
    out.push(node);
  }
  return out;
}
