import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Book, Pages } from "../src/pdf/book";
import { chapters, segment } from "../src/ingest/segments";
import { MODEL, writeBrief, type Brief } from "../src/ingest/brief";
import { nameUnits } from "../src/ingest/name";
import { DEFAULTS, toUnits, type Unit } from "../src/ingest/units";
import { database, SHELF, transaction } from "../src/store/db";

/** One book on the shelf, with enough progress to render its card. */
export interface ShelfBook {
  id: string;
  title: string;
  pageCount: number;
  units: number;
  minutes: number;
  doneUnits: number;
  doneMinutes: number;
  /** Where reading stopped — the unit to resume at. */
  lastUnit: string | null;
  openedAt: string;
}

export interface CourseUnit extends Unit {
  done: boolean;
}

export interface Course {
  id: string;
  title: string;
  pageCount: number;
  hasPageLabels: boolean;
  outlineNodes: number;
  lastUnit: string | null;
  units: CourseUnit[];
}

export function shelf(): ShelfBook[] {
  const rows = database()
    .prepare(
      `SELECT b.id, b.title, b.page_count, b.last_unit, b.opened_at,
              COUNT(u.id)                                     AS units,
              COALESCE(SUM(u.minutes), 0)                     AS minutes,
              COUNT(u.done_at)                                AS done_units,
              COALESCE(SUM(CASE WHEN u.done_at IS NOT NULL THEN u.minutes END), 0) AS done_minutes
         FROM book b LEFT JOIN unit u ON u.book_id = b.id
        GROUP BY b.id
        ORDER BY b.opened_at DESC`,
    )
    .all() as any[];

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    pageCount: r.page_count,
    units: Number(r.units),
    minutes: Number(r.minutes),
    doneUnits: Number(r.done_units),
    doneMinutes: Number(r.done_minutes),
    lastUnit: r.last_unit,
    openedAt: r.opened_at,
  }));
}

/**
 * Ingest a PDF onto the shelf, or hand back the one already there.
 *
 * Identity is the sha256 of the bytes, not the filename: re-adding the same
 * file — renamed, moved, downloaded twice — returns the existing book with its
 * progress intact and, crucially, **does not run the naming pass again**. That
 * one model call is the only per-book cost in the system, and it is paid once.
 */
export async function add(
  bytes: Uint8Array,
  filename: string,
  targetMinutes = DEFAULTS.targetMinutes,
): Promise<{ id: string } | { error: string }> {
  const db = database();
  const id = createHash("sha256").update(bytes).digest("hex");

  const known = db.prepare("SELECT id FROM book WHERE id = ?").get(id) as { id: string } | undefined;
  if (known) {
    touch(id);
    return { id };
  }

  const title = filename.replace(/\.pdf$/i, "").trim() || "Untitled";
  const file = join(SHELF, `${id}.pdf`);
  await writeFile(file, bytes);

  let units: Unit[];
  let book: Book;
  try {
    book = await Book.open(file);
    units = toUnits(chapters(segment(book)), { ...DEFAULTS, targetMinutes });
  } catch (error) {
    await rm(file, { force: true });
    return { error: `${title} could not be read as a PDF (${(error as Error).message}).` };
  }

  if (units.length === 0) {
    await rm(file, { force: true });
    return {
      error:
        book.outline.length === 0
          ? `${title} has no bookmark outline, so there is no structure to cut into units. throughline needs a book with chapters — a paper or a scan won't ingest.`
          : `${title} has ${book.outline.length} outline nodes but none carry enough text to be a unit.`,
    };
  }

  // The one AI call in the system. Without a key the structural titles stand —
  // "Summary" instead of "Transaction Isolation Recap", but nothing breaks.
  let named = false;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      units = await nameUnits(units, title);
      named = true;
    } catch (error) {
      console.warn(`naming failed for ${title}, keeping structural titles:`, error);
    }
  }

  const now = new Date().toISOString();
  transaction(() => {
    db.prepare(
      `INSERT INTO book (id, title, file, page_count, has_page_labels, outline_nodes,
                         target_minutes, named, added_at, opened_at, last_unit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      id,
      title,
      file,
      book.pageCount,
      book.pageLabels ? 1 : 0,
      book.outline.length,
      targetMinutes,
      named ? 1 : 0,
      now,
      now,
    );

    const insert = db.prepare(
      `INSERT INTO unit (book_id, id, ord, title, chapter, page_from, page_to,
                         prose, code, minutes, covers, done_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    units.forEach((u, i) =>
      insert.run(
        id,
        u.id,
        i,
        u.title,
        u.chapter,
        u.from,
        u.to,
        u.prose,
        u.code,
        u.minutes,
        JSON.stringify(u.covers),
      ),
    );
  });

  return { id };
}

export function course(id: string): Course | null {
  const db = database();
  const book = db.prepare("SELECT * FROM book WHERE id = ?").get(id) as any;
  if (!book) return null;

  const rows = db
    .prepare("SELECT * FROM unit WHERE book_id = ? ORDER BY ord")
    .all(id) as any[];

  return {
    id: book.id,
    title: book.title,
    pageCount: book.page_count,
    hasPageLabels: book.has_page_labels === 1,
    outlineNodes: book.outline_nodes,
    lastUnit: book.last_unit,
    units: rows.map((r) => ({
      id: r.id,
      title: r.title,
      chapter: r.chapter,
      from: r.page_from,
      to: r.page_to,
      prose: r.prose,
      code: r.code,
      minutes: r.minutes,
      covers: JSON.parse(r.covers) as string[],
      done: r.done_at !== null,
    })),
  };
}

export function setDone(bookId: string, unitId: string, done: boolean): void {
  database()
    .prepare("UPDATE unit SET done_at = ? WHERE book_id = ? AND id = ?")
    .run(done ? new Date().toISOString() : null, bookId, unitId);
}

/** Remember where reading stopped, so the shelf can offer to resume. */
export function setPlace(bookId: string, unitId: string): void {
  database()
    .prepare("UPDATE book SET last_unit = ?, opened_at = ? WHERE id = ?")
    .run(unitId, new Date().toISOString(), bookId);
}

export function touch(bookId: string): void {
  database()
    .prepare("UPDATE book SET opened_at = ? WHERE id = ?")
    .run(new Date().toISOString(), bookId);
}

export async function forget(bookId: string): Promise<void> {
  const db = database();
  const row = db.prepare("SELECT file FROM book WHERE id = ?").get(bookId) as
    | { file: string }
    | undefined;
  db.prepare("DELETE FROM book WHERE id = ?").run(bookId);
  rendering.delete(bookId);
  if (row) await rm(row.file, { force: true });
}

/* ── briefings ─────────────────────────────────────────────────── */

/** Calls in flight, so opening a unit twice in a second doesn't buy two briefings. */
const writing = new Map<string, Promise<Brief>>();

/**
 * The briefing for one unit: read from the row if it's there, generated once if
 * it isn't.
 *
 * This is the only model call that scales with reading rather than with books,
 * so it is cached on disk beside progress: a unit is paid for the first time it
 * is opened and never again, and re-reading the book costs nothing.
 */
export async function brief(bookId: string, unitId: string): Promise<Brief | { error: string }> {
  const db = database();
  const row = db
    .prepare("SELECT primer, objectives FROM brief WHERE book_id = ? AND unit_id = ?")
    .get(bookId, unitId) as { primer: string; objectives: string } | undefined;
  if (row) return { primer: row.primer, objectives: JSON.parse(row.objectives) as string[] };

  if (!process.env.ANTHROPIC_API_KEY) {
    return { error: "No ANTHROPIC_API_KEY is set, so there is no briefing for this unit." };
  }

  const key = `${bookId}:${unitId}`;
  let pending = writing.get(key);
  if (!pending) {
    pending = generate(bookId, unitId).finally(() => writing.delete(key));
    writing.set(key, pending);
  }

  try {
    return await pending;
  } catch (error) {
    return { error: `Couldn't write the briefing: ${(error as Error).message}` };
  }
}

/** Throw away a unit's briefing so the next open writes a fresh one. */
export function unbrief(bookId: string, unitId: string): void {
  database().prepare("DELETE FROM brief WHERE book_id = ? AND unit_id = ?").run(bookId, unitId);
}

async function generate(bookId: string, unitId: string): Promise<Brief> {
  const db = database();
  const book = db.prepare("SELECT title FROM book WHERE id = ?").get(bookId) as
    | { title: string }
    | undefined;
  const unit = db
    .prepare("SELECT * FROM unit WHERE book_id = ? AND id = ?")
    .get(bookId, unitId) as any;
  if (!book || !unit) throw new Error("no such unit");

  const opening = pages(bookId);
  if (!opening) throw new Error("the book's file is missing from the shelf");
  const text = await (await opening).text(unit.page_from, unit.page_to);

  // Only what the reader has already been through: a primer that points forward
  // would be orienting them against pages they haven't seen.
  const preceding = db
    .prepare("SELECT id, title, chapter FROM unit WHERE book_id = ? AND ord < ? ORDER BY ord")
    .all(bookId, unit.ord) as { id: string; title: string; chapter: string }[];

  const written = await writeBrief({
    bookTitle: book.title,
    unit: {
      id: unit.id,
      title: unit.title,
      chapter: unit.chapter,
      from: unit.page_from,
      to: unit.page_to,
      minutes: unit.minutes,
      covers: JSON.parse(unit.covers) as string[],
    },
    text,
    preceding,
  });

  db.prepare(
    `INSERT OR REPLACE INTO brief (book_id, unit_id, primer, objectives, model, made_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    bookId,
    unitId,
    written.primer,
    JSON.stringify(written.objectives),
    MODEL,
    new Date().toISOString(),
  );

  return written;
}

/**
 * The opened PDF behind a shelved book, for page rendering only. Held for the
 * life of the server: the first page of a unit pays the open, the rest don't.
 */
const rendering = new Map<string, Promise<Pages>>();

export function pages(bookId: string): Promise<Pages> | null {
  const existing = rendering.get(bookId);
  if (existing) return existing;

  const row = database().prepare("SELECT file FROM book WHERE id = ?").get(bookId) as
    | { file: string }
    | undefined;
  if (!row) return null;

  const opening = Pages.open(row.file);
  rendering.set(bookId, opening);
  return opening;
}
