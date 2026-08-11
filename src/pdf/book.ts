import { readFile } from "node:fs/promises";
// Legacy build: the modern one reaches for DOM APIs and fails with a confusing
// "DOMMatrix is not defined" under Node. See docs/research/01-pdfjs-capabilities.md.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

/** A node from the PDF's bookmark outline, with its destination resolved to a page. */
export interface OutlineNode {
  title: string;
  /** 1-based PDF page index. */
  page: number;
  /** 1 for top-level nodes. */
  depth: number;
}

/** How much prose and how much code sits on one page. */
export interface PageDensity {
  prose: number;
  code: number;
}

/**
 * One text item, placed the way pdf.js's own `TextLayer` places it.
 *
 * Coordinates are in PDF units with the origin at the page box's top-left, so
 * nothing here knows what scale the page was rendered at — the browser divides
 * by the page box and multiplies by whatever width the image is given. That is
 * what lets one response serve every zoom level.
 *
 * `x`/`y` are the *baseline* origin rather than the span's corner, because the
 * corner needs a font ascent and the ascent depends on the font the browser
 * substitutes. That one number is the only thing the client has to measure.
 */
export interface TextSpan {
  str: string;
  x: number;
  y: number;
  /** Font height in PDF units. */
  height: number;
  /** Radians. 0 for ordinary horizontal text, which is nearly all of it. */
  angle: number;
  /** The width the PDF draws it at, when the span must be stretched to match; else null. */
  drawn: number | null;
  /** A generic CSS family — `serif`, `sans-serif`, `monospace`. */
  family: string;
  dir: string;
  /** pdf.js ends a line after any item carrying this, text or not. See `TextSpan` use in the reader. */
  eol: boolean;
}

/** One of the book's own links, as a box over the page. */
export interface PageLink {
  /** Fractions of the page box. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** 1-based page it points at; null when it points out of the book. */
  page: number | null;
  /** Where it points outside the book. Never null at the same time as `page`. */
  url: string | null;
  /**
   * The PDF's own name for the destination — `sec_storage_b_trees`, `ch_storage`.
   *
   * Kept because the name classifies the edge mechanically: DDIA's `sec_*` and
   * `ch_*` links are the cross-references, and the other 83% are index and
   * bibliography plumbing. Null on books whose destinations are raw arrays.
   */
  dest: string | null;
}

/** Everything needed to lay a selectable text layer over a rendered page. */
export interface PageGeometry {
  /** The page box in PDF units — the denominator for every coordinate above. */
  width: number;
  height: number;
  spans: TextSpan[];
  links: PageLink[];
}

/**
 * A book opened for ingest. Everything the structural pass needs, read once.
 *
 * Deliberately does not expose the pdf.js document: `fontName` is a load-order
 * dependent alias that must never escape the session that produced it, so font
 * resolution happens in here and only `PageDensity` and repaired `lines` come
 * out. Both are taken from the same walk — the page text is read once and two
 * things are made of it, because reading it is what costs.
 */
export class Book {
  private constructor(
    readonly path: string,
    readonly pageCount: number,
    /** null when the PDF carries no /PageLabels — printed pages are then unresolvable. */
    readonly pageLabels: string[] | null,
    readonly outline: OutlineNode[],
    readonly density: PageDensity[],
    private readonly pageLines: string[][],
    private readonly printedIndex: Map<string, number>,
  ) {}

  static async open(path: string): Promise<Book> {
    const data = new Uint8Array(await readFile(path));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;

    const pageLabels = await doc.getPageLabels();
    const outline = await flattenOutline(doc);

    const density: PageDensity[] = [{ prose: 0, code: 0 }]; // index 0 unused; pages are 1-based
    const pageLines: string[][] = [[]];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let prose = 0;
      let code = 0;
      const lines: string[] = [];
      let buf = "";
      let bufCode = 0;
      let lastFont: string | null = null;

      // Code listings are out of the passage corpus — Kobil's call, recorded on
      // #21 — but the test is the line, not the item. An inline `null` in the
      // middle of a sentence is set in the code font too, and dropping it
      // leaves "an algorithm that always decides , no matter what was proposed".
      const flush = () => {
        const line = buf.trim();
        if (line && bufCode * 2 <= line.length) lines.push(line);
        buf = "";
        bufCode = 0;
        lastFont = null;
      };

      for (const item of content.items as any[]) {
        // Resolved here and now: the alias is only meaningful within this load.
        const family =
          typeof item.str === "string" ? content.styles?.[item.fontName]?.fontFamily : undefined;

        if (item.str?.trim()) {
          if (family === "monospace") code += item.str.length;
          else prose += item.str.length;
        }

        if (typeof item.str === "string" && item.str) {
          buf += (welds(buf, item.str, lastFont, item.fontName) ? " " : "") + item.str;
          if (family === "monospace") bufCode += item.str.length;
          lastFont = item.fontName;
        }
        // pdf.js marks the end of a rendered line, on text items and on some
        // that carry none; without it a page is one run-on string.
        if (item.hasEOL) flush();
      }
      flush();

      density[p] = { prose, code };
      pageLines[p] = lines;
      page.cleanup();
    }

    // First occurrence wins — a label repeated across ranges points at its first page.
    const printedIndex = new Map<string, number>();
    pageLabels?.forEach((label, i) => {
      if (!printedIndex.has(label)) printedIndex.set(label, i + 1);
    });

    return new Book(path, doc.numPages, pageLabels, outline, density, pageLines, printedIndex);
  }

  /**
   * One page's prose as rendered lines, code excluded and word breaks repaired.
   *
   * This is the raw material of a passage. What it is *not* is layout: nothing
   * here knows a heading from a footnote, and #26 measured that retrieval does
   * not need it to. What retrieval does need is that the words are words —
   * see `welds`.
   */
  lines(page: number): string[] {
    return this.pageLines[page] ?? [];
  }

  /** Printed page number as the book prints it, or null when it prints none. */
  printedOf(page: number): string | null {
    return this.pageLabels?.[page - 1] ?? null;
  }

  /**
   * Printed page number as the book prints it -> 1-based PDF page index.
   *
   * Only citations need this. Outline destinations are already PDF indices, so
   * unit slicing works on books with no page labels at all.
   */
  printedToIndex(printed: string): number | null {
    return this.printedIndex.get(printed) ?? null;
  }

  proseIn(from: number, to: number): number {
    return this.sum(from, to, "prose");
  }

  codeIn(from: number, to: number): number {
    return this.sum(from, to, "code");
  }

  private sum(from: number, to: number, key: keyof PageDensity): number {
    let total = 0;
    for (let p = Math.max(1, from); p <= Math.min(this.pageCount, to); p++) {
      total += this.density[p][key];
    }
    return total;
  }
}

/**
 * A book opened only to be looked at.
 *
 * Reading a shelved book must not pay for ingest again: `Book.open` walks every
 * page for its text density, which is seconds of work the viewer has no use for
 * — its units already came out of the database.
 */
export class Pages {
  private constructor(
    readonly pageCount: number,
    private readonly doc: any,
  ) {}

  static async open(path: string): Promise<Pages> {
    const data = new Uint8Array(await readFile(path));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
    return new Pages(doc.numPages, doc);
  }

  /**
   * The text of a page range, as close to reading order as pdf.js gives it,
   * with every page preceded by a `[[page N]]` marker.
   *
   * This is what a briefing is written from: the author's own words for exactly
   * the pages the unit spans. Nothing is summarised or selected on the way out
   * — a unit's whole range is ~8k tokens, so there is no reason to sample it.
   *
   * The markers are what make a page citation possible at all. Without them the
   * model sees one undifferentiated run of prose and any page number it produces
   * is invented — which is the exact failure the citations exist to prevent. The
   * doubled brackets are deliberate: nothing in a book's own text looks like it,
   * so a marker can never be mistaken for the author's words.
   */
  async text(from: number, to: number): Promise<string> {
    const out: string[] = [];
    for (let p = Math.max(1, from); p <= Math.min(this.pageCount, to); p++) {
      const page = await this.doc.getPage(p);
      const content = await page.getTextContent();
      let line = "";
      const lines: string[] = [];
      for (const item of content.items as any[]) {
        if (typeof item.str !== "string") continue;
        line += item.str;
        // pdf.js marks the end of a rendered line; without it every page comes
        // out as one run-on string and the structure the model reads is lost.
        if (item.hasEOL) {
          lines.push(line.trim());
          line = "";
        }
      }
      if (line.trim()) lines.push(line.trim());
      page.cleanup();
      out.push(`[[page ${p}]]\n${lines.filter(Boolean).join("\n")}`);
    }
    return out.join("\n\n");
  }

  /**
   * Where every word on a page sits, and where every link on it goes.
   *
   * This is the other half of `render`: the PNG is what you look at, this is
   * what you select, copy and click. It stays on the server for the same reason
   * the render does — the browser would need pdf.js and the whole PDF to work
   * out numbers that take ~20 ms here, and the alias resolution below must not
   * escape this load. Measured at 5–10 KB a page against the PNG's ~660 KB.
   *
   * The arithmetic is pdf.js's own `TextLayer`, moved to the server; see
   * docs/research/02-interactive-page-pane.md for why that is possible at all.
   */
  async geometry(page: number): Promise<PageGeometry> {
    const pdfPage = await this.doc.getPage(page);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const { pageWidth, pageHeight, pageX, pageY } = viewport.rawDims;

    // pdf.js's text-layer transform: flip the y axis and put the origin at the
    // page box's top-left. `TextLayer` constructor, build/pdf.mjs:14877.
    const flip = [1, 0, 0, -1, -pageX, pageY + pageHeight];

    const content = await pdfPage.getTextContent();
    const spans: TextSpan[] = [];
    for (const item of content.items as any[]) {
      if (typeof item.str !== "string") continue;
      // Resolved here, like `Book.open` does: the alias is only meaningful
      // within the load that produced it and must never reach the client.
      const style = content.styles?.[item.fontName];
      const tx = pdfjs.Util.transform(flip, item.transform);
      const angle = Math.atan2(tx[1], tx[0]) + (style?.vertical ? Math.PI / 2 : 0);

      spans.push({
        str: item.str,
        x: tx[4],
        y: tx[5],
        height: Math.hypot(tx[2], tx[3]),
        angle,
        drawn: stretched(item, style) ? (style?.vertical ? item.height : item.width) : null,
        family: style?.fontFamily ?? "sans-serif",
        dir: item.dir ?? "ltr",
        eol: Boolean(item.hasEOL),
      });
    }

    const links: PageLink[] = [];
    for (const annotation of (await pdfPage.getAnnotations()) as any[]) {
      if (annotation.subtype !== "Link") continue;
      // Annotation rects are in the PDF's own bottom-left space, so they get
      // the same flip the spans got — expressed as fractions, since a link box
      // has no font size to carry.
      const [x1, y1, x2, y2] = annotation.rect;

      // An annotation that resolves to nowhere is not a link. DDIA has none —
      // all 6,985 internal links resolve — but Clean Code carries 1,751 with no
      // destination at all, and drawn over the page they are dead anchors.
      const target = annotation.dest ? await resolveDestination(this.doc, annotation.dest) : null;
      const url = annotation.url ?? null;
      if (target === null && url === null) continue;

      links.push({
        left: (Math.min(x1, x2) - pageX) / pageWidth,
        top: (pageY + pageHeight - Math.max(y1, y2)) / pageHeight,
        width: Math.abs(x2 - x1) / pageWidth,
        height: Math.abs(y2 - y1) / pageHeight,
        page: target,
        url,
        dest: typeof annotation.dest === "string" ? annotation.dest : null,
      });
    }

    pdfPage.cleanup();
    return { width: pageWidth, height: pageHeight, spans, links };
  }

  /**
   * Render one page to a PNG.
   *
   * Server-side rather than shipping the PDF to the browser: it keeps pdf.js
   * out of the client bundle entirely, which is where the Next.js integration
   * pain lives (worker resolution, Terser on .mjs, the file tracer missing
   * dynamic imports). The text layer that costs — see `geometry`, which puts
   * selection back without giving any of this up.
   */
  async render(page: number, scale = 2): Promise<Buffer> {
    const { createCanvas } = await import("@napi-rs/canvas");
    const pdfPage = await this.doc.getPage(page);
    const viewport = pdfPage.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    await pdfPage.render({ canvasContext: context as any, viewport, canvas: canvas as any }).promise;
    pdfPage.cleanup();
    return canvas.toBuffer("image/png");
  }
}

/**
 * Whether a space has to be put back between two text items.
 *
 * pdf.js starts a new item wherever the font changes, and a change mid-word is
 * how emphasis is set — so joining the items blind welds the words on either
 * side of it together. DDIA's "as *fractal*" arrives as `as` + `fractal` and
 * becomes `asfractal`, which no query will ever match.
 *
 * A font change is not on its own a word break, though: the punctuation closing
 * an italic phrase is set in the roman font too, and spacing that would give
 * `B-trees .`. So the split only counts as a word break when neither side is
 * already spaced and neither side is the punctuation that hugs a word.
 */
const OPENS = /[([{'"‘“¿¡]$/;
const CLOSES = /^[.,;:!?)\]}'"’”…%]/;

function welds(buf: string, str: string, lastFont: string | null, font: string): boolean {
  if (!buf || !lastFont || font === lastFont) return false;
  return !/\s$/.test(buf) && !/^\s/.test(str) && !OPENS.test(buf) && !CLOSES.test(str);
}

/**
 * Whether a span has to be squeezed to the width the PDF drew it at.
 *
 * A substituted font almost never measures the same as the embedded one, so
 * anything longer than a character gets stretched to match; single characters
 * are left alone unless the PDF itself distorted them. `TextLayer#appendText`,
 * build/pdf.mjs:15037.
 */
function stretched(item: any, style: any): boolean {
  if (item.str.length > 1) return true;
  if (item.str === " " || item.transform[0] === item.transform[3]) return false;
  const x = Math.abs(item.transform[0]);
  const y = Math.abs(item.transform[3]);
  return x !== y && Math.max(x, y) / Math.min(x, y) > 1.5;
}

async function flattenOutline(doc: any): Promise<OutlineNode[]> {
  const raw = await doc.getOutline();
  if (!raw) return [];

  const nodes: OutlineNode[] = [];
  const visit = async (items: any[], depth: number) => {
    for (const item of items) {
      const page = await resolveDestination(doc, item.dest);
      if (page !== null) nodes.push({ title: item.title.trim(), page, depth });
      if (item.items?.length) await visit(item.items, depth + 1);
    }
  };
  await visit(raw, 1);

  // Outline order is authored order, which is usually page order but isn't
  // guaranteed to be. Everything downstream assumes page order.
  return nodes.sort((a, b) => a.page - b.page || a.depth - b.depth);
}

async function resolveDestination(doc: any, dest: unknown): Promise<number | null> {
  try {
    const resolved = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(resolved)) return null;
    return (await doc.getPageIndex(resolved[0])) + 1;
  } catch {
    return null;
  }
}
