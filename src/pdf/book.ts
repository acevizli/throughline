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
 * A book opened for ingest. Everything the structural pass needs, read once.
 *
 * Deliberately does not expose the pdf.js document: `fontName` is a load-order
 * dependent alias that must never escape the session that produced it, so font
 * resolution happens in here and only `PageDensity` comes out.
 */
export class Book {
  private constructor(
    readonly path: string,
    readonly pageCount: number,
    /** null when the PDF carries no /PageLabels — printed pages are then unresolvable. */
    readonly pageLabels: string[] | null,
    readonly outline: OutlineNode[],
    readonly density: PageDensity[],
    private readonly printedIndex: Map<string, number>,
  ) {}

  static async open(path: string): Promise<Book> {
    const data = new Uint8Array(await readFile(path));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;

    const pageLabels = await doc.getPageLabels();
    const outline = await flattenOutline(doc);

    const density: PageDensity[] = [{ prose: 0, code: 0 }]; // index 0 unused; pages are 1-based
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let prose = 0;
      let code = 0;
      for (const item of content.items as any[]) {
        if (!item.str?.trim()) continue;
        // Resolved here and now: the alias is only meaningful within this load.
        const family = content.styles?.[item.fontName]?.fontFamily;
        if (family === "monospace") code += item.str.length;
        else prose += item.str.length;
      }
      density[p] = { prose, code };
      page.cleanup();
    }

    // First occurrence wins — a label repeated across ranges points at its first page.
    const printedIndex = new Map<string, number>();
    pageLabels?.forEach((label, i) => {
      if (!printedIndex.has(label)) printedIndex.set(label, i + 1);
    });

    return new Book(path, doc.numPages, pageLabels, outline, density, printedIndex);
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
   * The text of a page range, as close to reading order as pdf.js gives it.
   *
   * This is what a briefing is written from: the author's own words for exactly
   * the pages the unit spans. Nothing is summarised or selected on the way out
   * — a unit's whole range is ~8k tokens, so there is no reason to sample it.
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
      out.push(lines.filter(Boolean).join("\n"));
    }
    return out.join("\n\n");
  }

  /**
   * Render one page to a PNG.
   *
   * Server-side rather than shipping the PDF to the browser: it keeps pdf.js
   * out of the client bundle entirely, which is where the Next.js integration
   * pain lives (worker resolution, Terser on .mjs, the file tracer missing
   * dynamic imports). The cost is no selectable text layer in the viewer —
   * fine for reading, and the coordinate work for highlighting can move
   * client-side later without changing the ingest half.
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
