import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Book, Pages } from "../src/pdf/book";
import { chapters, segment } from "../src/ingest/segments";
import { KEYS, writeBrief, type Brief, type Key, type Question } from "../src/ingest/brief";
import { nameUnits } from "../src/ingest/name";
import { backend, MODEL, unready } from "../src/model/ask";
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
  /** Units answered with every question right. */
  clean: number;
  /** Units answered with something missed. Never subtracted from progress. */
  shaky: number;
  /** Where reading stopped — the unit to resume at. */
  lastUnit: string | null;
  openedAt: string;
}

export interface CourseUnit extends Unit {
  done: boolean;
  /** The last attempt at this unit's questions, if it has been taken. */
  recall: { score: number; outOf: number } | null;
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
              COALESCE(SUM(CASE WHEN u.done_at IS NOT NULL THEN u.minutes END), 0) AS done_minutes,
              COUNT(CASE WHEN a.score = a.out_of THEN 1 END)  AS clean,
              COUNT(CASE WHEN a.score < a.out_of THEN 1 END)  AS shaky
         FROM book b
         LEFT JOIN unit u    ON u.book_id = b.id
         LEFT JOIN attempt a ON a.book_id = u.book_id AND a.unit_id = u.id
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
    clean: Number(r.clean),
    shaky: Number(r.shaky),
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

  // The one model call ingest makes. With no backend reachable the structural
  // titles stand — "Summary" instead of "Transaction Isolation Recap" — but
  // nothing breaks. Gated on the backend rather than on a key: the agent path
  // needs no key, and checking for one here would have quietly skipped naming
  // for every book added through the shelf.
  let named = false;
  if (!unready()) {
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
    .prepare(
      `SELECT u.*, a.score, a.out_of
         FROM unit u
         LEFT JOIN attempt a ON a.book_id = u.book_id AND a.unit_id = u.id
        WHERE u.book_id = ?
        ORDER BY u.ord`,
    )
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
      recall: r.out_of === null ? null : { score: Number(r.score), outOf: Number(r.out_of) },
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
  if (row) {
    return {
      primer: row.primer,
      objectives: JSON.parse(row.objectives) as string[],
      questions: questionsFor(bookId, unitId),
    };
  }

  const blocked = unready();
  if (blocked) return { error: `${blocked} There is no briefing for this unit.` };

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

/**
 * Throw away a unit's briefing so the next open writes a fresh one.
 *
 * The questions go with it: they were written in the same call, against the
 * same objectives, so keeping them beside a rewritten set would leave a unit
 * being asked about capabilities it no longer claims to teach. The attempt goes
 * too — a score against questions that no longer exist means nothing.
 */
export function unbrief(bookId: string, unitId: string): void {
  const db = database();
  transaction(() => {
    for (const table of ["brief", "question", "attempt"]) {
      db.prepare(`DELETE FROM ${table} WHERE book_id = ? AND unit_id = ?`).run(bookId, unitId);
    }
  });
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

  transaction(() => {
    db.prepare(
      `INSERT OR REPLACE INTO brief (book_id, unit_id, primer, objectives, model, made_at, questions)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      bookId,
      unitId,
      written.primer,
      JSON.stringify(written.objectives),
      // Which backend wrote it, not just which model: two rows made by the same
      // model through different paths are not the same artefact, and telling
      // them apart afterwards is the whole point of keeping both.
      `${backend()}:${MODEL}`,
      new Date().toISOString(),
      written.questions.length,
    );

    const insert = db.prepare(
      `INSERT OR REPLACE INTO question (book_id, unit_id, ord, stem, options, correct)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    written.questions.forEach((q, i) =>
      insert.run(bookId, unitId, i, q.stem, JSON.stringify(q.options), JSON.stringify(q.correct)),
    );
  });

  return written;
}

/* ── questions ─────────────────────────────────────────────────── */

/** A question as the reader sees it: no correct keys, and no page numbers. */
export interface AskedQuestion {
  ord: number;
  stem: string;
  options: { key: Key; text: string }[];
}

/** A marked question, with everything that was hidden while answering. */
export interface MarkedQuestion {
  ord: number;
  stem: string;
  options: { key: Key; text: string; page: number; correct: boolean; picked: boolean }[];
  /** 1, 0.5 or 0 — see `grade`. */
  got: number;
}

export interface Marked {
  score: number;
  outOf: number;
  takenAt: string;
  questions: MarkedQuestion[];
}

export type Quiz =
  | { state: "asking"; questions: AskedQuestion[] }
  | { state: "marked"; result: Marked }
  | { state: "none"; reason: string };

/**
 * A unit's questions — unanswered, or the marked result if they've been taken.
 *
 * Nothing that could give an answer away crosses to the client while the
 * questions are open: no `correct`, and no page numbers either, since four
 * anchors clustered on one page is a tell. The reader gets stems and option
 * text, and everything else arrives with the marking.
 */
export async function quiz(bookId: string, unitId: string): Promise<Quiz> {
  const db = database();

  const taken = db
    .prepare("SELECT picks, score, out_of, taken_at FROM attempt WHERE book_id = ? AND unit_id = ?")
    .get(bookId, unitId) as
    | { picks: string; score: number; out_of: number; taken_at: string }
    | undefined;

  // A briefing written before questions existed carries -1 and has to be paid
  // for again; one whose questions were all dropped carries 0 and must not be,
  // or every open would buy another doomed call.
  const legacy = db
    .prepare("SELECT questions FROM brief WHERE book_id = ? AND unit_id = ?")
    .get(bookId, unitId) as { questions: number } | undefined;
  if (legacy?.questions === -1) unbrief(bookId, unitId);

  // Written in the same call as the briefing, so asking for one buys both.
  const written = await brief(bookId, unitId);
  if ("error" in written) return { state: "none", reason: written.error };

  const stored = questionsFor(bookId, unitId);
  if (stored.length === 0) {
    return {
      state: "none",
      reason:
        "No questions survived for this unit — every one the model wrote cited a page outside " +
        "its range. Rewriting the briefing will try again.",
    };
  }

  if (taken) {
    return {
      state: "marked",
      result: assemble(stored, JSON.parse(taken.picks) as Key[][], taken.taken_at),
    };
  }

  return {
    state: "asking",
    questions: stored.map((q, ord) => ({
      ord,
      stem: q.stem,
      options: KEYS.map((key) => ({ key, text: q.options[key].text })),
    })),
  };
}

/** Mark an attempt, store it in place of any previous one, and hand back the result. */
export function mark(bookId: string, unitId: string, picks: Key[][]): Marked | { error: string } {
  const stored = questionsFor(bookId, unitId);
  if (stored.length === 0) return { error: "this unit has no questions" };

  const cleaned = stored.map((_, i) => [...new Set(picks[i] ?? [])].filter((k) => KEYS.includes(k)));
  const result = assemble(stored, cleaned, new Date().toISOString());

  database()
    .prepare(
      `INSERT OR REPLACE INTO attempt (book_id, unit_id, picks, score, out_of, taken_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      bookId,
      unitId,
      JSON.stringify(cleaned),
      result.score,
      result.outOf,
      result.takenAt,
    );

  return result;
}

/** Clear the stored attempt so the same questions can be taken again. */
export function retake(bookId: string, unitId: string): void {
  database().prepare("DELETE FROM attempt WHERE book_id = ? AND unit_id = ?").run(bookId, unitId);
}

function questionsFor(bookId: string, unitId: string): Question[] {
  return (
    database()
      .prepare("SELECT stem, options, correct FROM question WHERE book_id = ? AND unit_id = ? ORDER BY ord")
      .all(bookId, unitId) as { stem: string; options: string; correct: string }[]
  ).map((r) => ({
    stem: r.stem,
    options: JSON.parse(r.options) as Question["options"],
    correct: JSON.parse(r.correct) as Key[],
  }));
}

function assemble(questions: Question[], picks: Key[][], takenAt: string): Marked {
  const marked = questions.map((q, ord) => {
    const picked = picks[ord] ?? [];
    return {
      ord,
      stem: q.stem,
      options: KEYS.map((key) => ({
        key,
        text: q.options[key].text,
        page: q.options[key].page,
        correct: q.correct.includes(key),
        picked: picked.includes(key),
      })),
      got: grade(q.correct, picked),
    };
  });

  return {
    score: marked.reduce((n, q) => n + q.got, 0),
    outOf: marked.length,
    takenAt,
    questions: marked,
  };
}

/**
 * Exact set, half credit, or nothing.
 *
 * A subset of the correct options with nothing wrong alongside it scores a half
 * — right as far as it went. One wrong pick is worth zero however much else was
 * right: the second option exists precisely to catch a half-held idea, and
 * paying out for it would defeat not telling the reader how many to look for.
 */
function grade(correct: Key[], picked: Key[]): number {
  if (picked.length === 0) return 0;
  if (picked.some((k) => !correct.includes(k))) return 0;
  return picked.length === correct.length ? 1 : 0.5;
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
