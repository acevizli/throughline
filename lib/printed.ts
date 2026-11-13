/**
 * How a page number is written where a reader reads it.
 *
 * Everything inside throughline counts pages the way the PDF does: 1-based
 * sheets. That is what outline destinations resolve to, what `[[page N]]`
 * markers say, what a question's page anchor stores, and what the `page-N`
 * scroll targets are. The book prints something else — DDIA's sheet 135 carries
 * the folio **113**, after a cover, a back cover and twenty roman-numbered
 * pages — so a reader shown the sheet number reads a citation that is 22 pages
 * wrong.
 *
 * The conversion happens here and nowhere else. Converting earlier would put
 * two page numbers into circulation, and the one the machinery uses to slice,
 * scroll and validate must stay the PDF's. Converting later isn't possible:
 * this is the last stop before the screen.
 *
 * The labels come from the PDF's own `/PageLabels` dictionary via
 * `getPageLabels()` — never an inferred offset, never scraped from a footer.
 * #3 measured both fallbacks: footer scraping reads the right number on 98.4%
 * of DDIA's pages and 13.4% of Clean Code's, which is not a mechanism. So a
 * book that carries no labels has no printed page numbers to show, and the
 * reader is told that rather than handed an index dressed as a folio.
 */

/** A book's `/PageLabels`, indexed by PDF page minus one. Null when it has none. */
export type Labels = string[] | null;

/** The number the book prints on a sheet, or null when it prints none. */
export function printedOf(labels: Labels, page: number): string | null {
  return labels?.[page - 1] ?? null;
}

// A label is not always a number: DDIA's first two are `Cover` and `BackCover`,
// and `p.Cover` reads as a bug. Roman numerals keep the prefix — front matter
// is paginated, just not in arabic.
const NUMBERED = /^(\d+|[ivxlcdm]+)$/i;

/**
 * One page, cited: `p.113`, `p.xiv`, `Cover` — or `pdf 135` on a book with no
 * folios, where the sheet number is all there is and says so.
 */
export function cite(labels: Labels, page: number): string {
  const label = printedOf(labels, page);
  if (label === null) return `pdf ${page}`;
  return NUMBERED.test(label) ? `p.${label}` : label;
}

/** A page range, cited: `pp. 113–131`, `p. 113`, `pdf pp. 135–150`. */
export function citeRange(labels: Labels, from: number, to: number): string {
  const first = printedOf(labels, from);
  const last = printedOf(labels, to);
  if (first === null || last === null) {
    return from === to ? `pdf p. ${from}` : `pdf pp. ${from}–${to}`;
  }
  return from === to ? `p. ${first}` : `pp. ${first}–${last}`;
}

/**
 * The caption under a rendered page.
 *
 * Bare, and no `pdf` marker when there are no labels: this one counts the
 * sheets you are scrolling through rather than citing anything, it sits under
 * every page rather than at the end of a claim, and on a labelled book it
 * simply agrees with the folio printed on the page above it.
 */
export function caption(labels: Labels, page: number): string {
  return printedOf(labels, page) ?? String(page);
}
