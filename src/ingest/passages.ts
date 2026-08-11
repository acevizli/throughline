import { createHash } from "node:crypto";
import type { Book } from "../pdf/book";
import { chapters, segment, CHAPTER_TITLE, NON_TEACHING } from "./segments";

/**
 * A passage: one stretch of the author's own prose, long enough to stand alone
 * and short enough to be about one thing.
 *
 * This is what retrieval ranks and what the reader is shown, so it is the book
 * verbatim — the no-drift constraint has nothing to enforce here, because
 * nothing is written. The page range and the breadcrumb are what make it
 * traceable back to the paper.
 */
export interface Passage {
  /** Stable across re-extraction: the text's own hash. See `identify`. */
  id: string;
  ord: number;
  text: string;
  /** 1-based PDF pages, inclusive. A passage may straddle a page break. */
  from: number;
  to: number;
  /** Printed page numbers, or null on a book that carries no /PageLabels. */
  printedFrom: string | null;
  printedTo: string | null;
  /** Where in the book it came from, for showing beside the text. */
  chapter: string;
  section: string;
}

export interface PassageOptions {
  /** Characters to aim for. Sentences are never cut, so this is a floor. */
  size: number;
  /** Share of a passage repeated at the start of the next one. */
  overlap: number;
}

/**
 * Measured on DDIA chapter 3 against per-paragraph chunking, which they matched
 * on every hit and beat on every miss — #26, closed. Neither number is tuned to
 * the book: the size is a property of the embedding model's useful context and
 * the overlap is what replaces small-to-big. Retuning belongs to the miss log
 * (#25), where a failure that was actually noticed while reading pays for it.
 */
export const PASSAGE_DEFAULTS: PassageOptions = { size: 900, overlap: 0.25 };

/** What was cut out on the way, worth printing once per book. */
export interface PassageReport {
  passages: Passage[];
  /** The body of the book: everything outside it is apparatus. */
  from: number;
  to: number;
  /** Running heads and feet found and dropped, as shapes. */
  furniture: string[];
  /** Hyphen characters found to be the typesetter's, and so removed at breaks. */
  breaks: string[];
  /** Characters of prose the passages were cut from. */
  chars: number;
  /** Passages dropped for repeating text already seen. */
  duplicates: number;
  /**
   * Non-space characters of the page text that reached no passage at all. Must
   * be zero: a book quietly missing sentences is a book retrieval cannot find
   * them in, and the sentence splitter lost text exactly that way once already
   * — silently, because everything it did emit still read as fluent English.
   */
  lost: number;
}

/**
 * Cut a book's body into passages.
 *
 * The whole mechanism: repair the stream, then make the chunks big. There is no
 * paragraph detection and no layout analysis here, and that is the finding
 * rather than an omission — per-paragraph chunking was measured and it lost,
 * because small chunks give a footnote a fair fight against a section.
 */
export function passages(
  book: Book,
  options: PassageOptions = PASSAGE_DEFAULTS,
  /** A slice to extract instead of the body, in 1-based PDF pages. For probes. */
  range?: { from: number; to: number },
): PassageReport {
  // A flag with its value left off reads as 0, and NaN compares false against
  // everything — both would once have hung here rather than complained.
  if (!(options.size > 0)) throw new Error(`passage size must be above zero, got ${options.size}`);
  if (!(options.overlap >= 0 && options.overlap < 1)) {
    throw new Error(`passage overlap must be at least 0 and below 1, got ${options.overlap}`);
  }

  const { from, to } = range ?? body(book);
  const furniture = runningHeads(book, from, to);
  const breaks = breakHyphens(book, from, to);
  const where = breadcrumbs(book);

  // One string for the whole body, with an index back to the page each stretch
  // of it came off. Windows are cut from this rather than page by page, so a
  // passage can straddle a page break the way the sentence does.
  let stream = "";
  const bounds: { at: number; page: number }[] = [];
  for (let p = from; p <= to; p++) {
    const text = join(
      book.lines(p).filter((l, i, all) => !isFurniture(l, i, all, furniture)),
      breaks,
    );
    if (!text) continue;

    // A page break splits a word exactly the way a line break does, so the
    // pages join by the same rule rather than by a space.
    let glue = " ";
    if (!stream) glue = "";
    else if (endsHyphenated(stream)) {
      glue = "";
      if (breaks.has(stream.slice(-1))) stream = stream.slice(0, -1);
    }
    bounds.push({ at: stream.length + glue.length, page: p });
    stream += glue + text;
  }

  const pageAt = (offset: number): number => {
    let page = bounds[0]?.page ?? from;
    for (const b of bounds) {
      if (b.at > offset) break;
      page = b.page;
    }
    return page;
  };

  const sentences = sentencesOf(stream);
  const solid = (text: string) => text.replace(/\s+/g, "").length;
  // Two ways a sentence can vanish between the page and a passage: the splitter
  // drops it, or no window ever reaches it. Both are counted, because both are
  // invisible in the output — what comes out reads perfectly either way.
  const reached = new Array<boolean>(sentences.length).fill(false);

  const out: Passage[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const window of windows(sentences, options)) {
    for (let s = window.from; s < window.to; s++) reached[s] = true;
    const id = identify(window.text);
    // Identical text really is the same passage — a repeated boilerplate line,
    // or the same window reached twice. Showing it twice in a result list is
    // noise, and embedding it twice is paying twice for one vector.
    if (seen.has(id)) {
      duplicates++;
      continue;
    }
    seen.add(id);

    const start = pageAt(window.at);
    const end = pageAt(window.at + window.text.length - 1);
    out.push({
      id,
      ord: out.length,
      text: window.text,
      from: start,
      to: end,
      printedFrom: book.printedOf(start),
      printedTo: book.printedOf(end),
      chapter: where.get(start)?.chapter ?? "",
      section: where.get(start)?.section ?? "",
    });
  }

  return {
    passages: out,
    from,
    to,
    lost: sentences.reduce(
      (n, s, i) => n - (reached[i] ? solid(s.text) : 0),
      solid(stream),
    ),
    furniture: [...furniture],
    breaks: [...breaks].filter((ch) => ch !== "­"),
    chars: stream.length,
    duplicates,
  };
}

/**
 * A passage's identity is its text, so re-extracting a book leaves the ids
 * alone and #23's embedding pass — forty minutes, resumed by looking for
 * passages with no vector — picks up where it stopped.
 *
 * Ordinal ids would survive a restart too, but not a re-extraction: changing
 * the window size by a character would leave every vector attached to text it
 * was not made from. That failure is silent, which is why it isn't risked.
 *
 * The whole digest, not a prefix of it. A prefix that collided would not error
 * — the loop below reads a repeated id as the same passage twice and drops the
 * second — so the failure mode is a passage vanishing from the book. At 64 bits
 * that is around one book in ten trillion, and at 256 it is nothing at all,
 * which is worth 48 bytes a row.
 */
function identify(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The body of the book: from the first chapter or part to the page before the
 * apparatus starts.
 *
 * Only top-level outline nodes are read, which is what keeps DDIA's per-chapter
 * bibliographies in — they sit a level down, and they were left in deliberately
 * (they rank below the hit band and above the miss ceiling, so the similarity
 * floor #23 has to build anyway is what handles them).
 *
 * On DDIA this stops at the Glossary, cutting 39 pages of glossary and index
 * that the book's own page labels call body pages. On a book whose index is not
 * a bookmark it cuts nothing — Clean Code's survives — and that is accepted
 * rather than solved: #26 measured the signal that catches it, and building it
 * waits for someone actually reading that book.
 */
function body(book: Book): { from: number; to: number } {
  const tops = book.outline.filter((n) => n.depth === 1);
  const start = tops.find((n) => CHAPTER_TITLE.test(n.title));
  if (!start) return { from: 1, to: book.pageCount };

  const apparatus = tops.find((n) => n.page > start.page && NON_TEACHING.test(n.title));
  return { from: start.page, to: (apparatus?.page ?? book.pageCount + 1) - 1 };
}

/**
 * The running head and foot, found by repetition alone.
 *
 * A page's first and last line are the only candidates, and blanking their
 * digits is what makes "Chapter 3: Storage and Retrieval | 79" and the same
 * line on page 80 the same thing. Anything that shape occurs on five or more
 * pages is furniture — no font size, no y coordinate, no page geometry.
 */
function runningHeads(book: Book, from: number, to: number): Set<string> {
  const counts = new Map<string, number>();
  for (let p = from; p <= to; p++) {
    const lines = book.lines(p);
    for (const line of [lines[0], lines[lines.length - 1]]) {
      if (line) counts.set(shape(line), (counts.get(shape(line)) ?? 0) + 1);
    }
  }
  return new Set([...counts].filter(([, n]) => n >= 5).map(([s]) => s));
}

const shape = (line: string): string => line.replace(/\d+/g, "#");

function isFurniture(line: string, i: number, all: string[], furniture: Set<string>): boolean {
  return (i === 0 || i === all.length - 1) && furniture.has(shape(line));
}

const HYPHENS = "-‐‑‒–—­";
const endsHyphenated = (text: string): boolean => text !== "" && HYPHENS.includes(text.slice(-1));

/**
 * Which hyphen characters this book breaks words with, as opposed to the ones
 * its author wrote.
 *
 * Both end a line, and telling them apart decides whether `safety-` + `critical`
 * is `safety-critical` or `safetycritical` — the second of which is a word no
 * query will ever match. There is no way to know from one line, but there is
 * from the whole book: a character the typesetter inserts at breaks appears
 * *only* at breaks. Measured, DDIA's U+2010 is 2,386 line-ends and no mid-line
 * use at all, while its ASCII hyphen is 3,859 mid-line against 150 — the second
 * is `write-ahead` and `half-finished`, which happen to break sometimes.
 *
 * A book with no such character (Clean Code breaks on the ASCII hyphen it also
 * writes compounds with) gets none of them stripped. Keeping a hyphen that
 * shouldn't be there is the recoverable mistake; welding two words is not.
 */
function breakHyphens(book: Book, from: number, to: number): Set<string> {
  const ends = new Map<string, number>();
  const middles = new Map<string, number>();
  const bump = (counts: Map<string, number>, ch: string) =>
    counts.set(ch, (counts.get(ch) ?? 0) + 1);

  for (let p = from; p <= to; p++) {
    for (const line of book.lines(p)) {
      for (const m of line.matchAll(/[-‐‑‒–—­]/g)) {
        bump(m.index === line.length - 1 ? ends : middles, m[0]);
      }
    }
  }

  // The soft hyphen is one by definition — it is invisible unless a line breaks
  // on it — so it needs no evidence.
  const out = new Set(["­"]);
  for (const [ch, at] of ends) {
    if (at >= 20 && at >= (middles.get(ch) ?? 0) * 9) out.add(ch);
  }
  return out;
}

/** Join a page's lines, putting back the words its line breaks split in half. */
function join(lines: string[], breaks: Set<string>): string {
  let text = "";
  for (const line of lines) {
    // Every hyphen at a line end joins the two halves with no space between
    // them; only the typesetter's own goes away with the break.
    if (endsHyphenated(text)) text = (breaks.has(text.slice(-1)) ? text.slice(0, -1) : text) + line;
    else text += (text ? " " : "") + line;
  }
  return text.trim();
}

/**
 * Cut a stream into overlapping windows, never through a sentence.
 *
 * The overlap is what small-to-big was going to be for: a point made across two
 * sentences that a cut falls between still appears whole in the neighbouring
 * window, so no retrieval-time expansion is needed to find it.
 */
function windows(
  sentences: Sentence[],
  { size, overlap }: PassageOptions,
): { text: string; at: number; from: number; to: number }[] {
  const out: { text: string; at: number; from: number; to: number }[] = [];
  for (let i = 0; i < sentences.length; ) {
    let text = "";
    let j = i;
    // `j === i` takes one sentence unconditionally. Without it a size that no
    // sentence can reach leaves j at i, the step-back below cannot move either,
    // and the loop spins forever on a book that looks perfectly ordinary.
    while (j < sentences.length && (j === i || text.length < size)) {
      text += (text ? " " : "") + sentences[j++].text;
    }
    // Below this a "passage" is a stray heading or a caption fragment, which
    // ranks on nothing and reads as noise beside the real results.
    if (text.length > 60) out.push({ text, at: sentences[i].at, from: i, to: j });
    if (j >= sentences.length) break;

    // Step back over whole sentences until enough of this window is carried
    // into the next one. Never past the second sentence, or a window longer
    // than the overlap allows would start where the last one did and repeat
    // forever.
    let back = j;
    let carried = 0;
    while (back > i + 1 && carried < text.length * overlap) carried += sentences[--back].text.length;
    i = back;
  }
  return out;
}

interface Sentence {
  text: string;
  /** Offset into the stream, for resolving the page it came off. */
  at: number;
}

/**
 * Split the stream into sentences without losing a character.
 *
 * The obvious regex — "a run of not-`.!?`, then a terminator, then whitespace"
 * — has a failure mode that costs text rather than misplacing it. At `(e.g.,
 * constraint violation)` the period is followed by a comma, so no alternative
 * can match at that position; `matchAll` moves the start one character along
 * and tries again, and everything it walks past is simply gone. That deleted a
 * sentence and a half from DDIA page 232, and nothing downstream could tell,
 * because what came out was still fluent English.
 *
 * So this cuts rather than matches: every character between two cuts is kept
 * and the pieces put back together are the input. Cutting at an abbreviation is
 * a cost worth paying for that — the pieces are only reassembled into windows,
 * so an extra boundary changes nothing.
 */
function sentencesOf(stream: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  const cut = (end: number) => {
    const piece = stream.slice(start, end);
    if (piece.trim()) out.push({ text: piece.trim(), at: start + (piece.length - piece.trimStart().length) });
    start = end;
  };
  // A terminator, plus whatever quote or bracket closes over it, then a space.
  for (const m of stream.matchAll(/[.!?]["'”’)\]]*(?=\s)/g)) cut(m.index + m[0].length);
  cut(stream.length);
  return out;
}

/**
 * Which section each page sits in, for the line shown above a result.
 *
 * Page-granular, so a page carrying the end of one section and the start of the
 * next is attributed to whichever opened it. That was rejected while passages
 * were paragraph-sized, where the paragraph above a mid-page heading would take
 * the wrong name outright; a passage spanning most of a page is mostly in the
 * section it is labelled with, and the alternative is heading detection —
 * exactly the layout analysis that #26 closed.
 */
function breadcrumbs(book: Book): Map<number, { chapter: string; section: string }> {
  const where = new Map<number, { chapter: string; section: string }>();
  for (const chapter of chapters(segment(book))) {
    for (const s of chapter.segments) {
      for (let p = s.from; p <= s.to; p++) where.set(p, { chapter: chapter.title, section: s.title });
    }
  }
  return where;
}
