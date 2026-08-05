import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Book } from "../src/pdf/book";
import { chapters, segment } from "../src/ingest/segments";
import { nameUnits } from "../src/ingest/name";
import { DEFAULTS, toUnits, type Unit } from "../src/ingest/units";

export interface Course {
  path: string;
  name: string;
  pageCount: number;
  hasPageLabels: boolean;
  outlineNodes: number;
  units: Unit[];
}

/**
 * One opened book per path, held for the life of the dev server.
 *
 * Ingest is fast enough (~2.5s) that persistence isn't needed yet — this is
 * what lets the viewer exist before the data-model ticket is settled. The
 * cached `Book` also keeps one pdf.js document alive per book, which page
 * rendering reuses and which font-alias stability depends on.
 */
const opened = new Map<string, Promise<{ book: Book; course: Course }>>();

export function ingest(path: string, targetMinutes = DEFAULTS.targetMinutes) {
  const key = `${path}::${targetMinutes}`;
  let existing = opened.get(key);
  if (!existing) {
    existing = load(path, targetMinutes);
    opened.set(key, existing);
  }
  return existing;
}

async function load(path: string, targetMinutes: number) {
  const book = await Book.open(path);
  let units = toUnits(chapters(segment(book)), { ...DEFAULTS, targetMinutes });

  // Concept titles cost one call and ~14s, paid once per book because the
  // result is cached above. Without a key the structural titles still work —
  // "Summary" instead of "Transaction Isolation Recap", but nothing breaks.
  if (units.length > 0 && process.env.ANTHROPIC_API_KEY) {
    const name = path.split("/").pop()!.replace(/\.pdf$/i, "");
    try {
      units = await nameUnits(units, name);
    } catch (error) {
      console.warn(`naming failed for ${name}, keeping structural titles:`, error);
    }
  }

  const course: Course = {
    path,
    name: path.split("/").pop()!.replace(/\.pdf$/i, ""),
    pageCount: book.pageCount,
    hasPageLabels: book.pageLabels !== null,
    outlineNodes: book.outline.length,
    units,
  };
  return { book, course };
}

/**
 * Books available to ingest. `THROUGHLINE_BOOKS` (colon-separated paths) wins;
 * otherwise scan ~/Downloads, which is where books actually land.
 */
export async function library(): Promise<{ path: string; name: string; mb: number }[]> {
  const configured = process.env.THROUGHLINE_BOOKS;
  const paths = configured
    ? configured.split(":").filter(Boolean)
    : await scan(join(homedir(), "Downloads"));

  const sized = await Promise.all(
    paths.map(async (path) => ({
      path,
      name: path.split("/").pop()!.replace(/\.pdf$/i, ""),
      mb: await size(path),
    })),
  );

  // Biggest first. A folder of PDFs is mostly papers and receipts; books are the
  // large ones, so size alone floats the plausible candidates to the top without
  // having to open all of them.
  return sized.sort((a, b) => b.mb - a.mb);
}

async function scan(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.toLowerCase().endsWith(".pdf")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

async function size(path: string): Promise<number> {
  try {
    return Math.round(((await stat(path)).size / 1024 / 1024) * 10) / 10;
  } catch {
    return 0;
  }
}
