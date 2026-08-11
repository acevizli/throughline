import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Where a shelf lives: the SQLite file next to a copy of every PDF on it.
 *
 * The PDFs are copied in rather than referenced where they were found. A
 * reference breaks the first time a file is moved out of Downloads, and the
 * shelf has to survive that — the AI naming pass is paid once per book and
 * losing the file would mean paying it again.
 */
export const HOME = process.env.THROUGHLINE_HOME ?? join(homedir(), ".throughline");
export const SHELF = join(HOME, "books");

/**
 * Each entry is one migration, applied in order and never edited afterwards.
 * `user_version` records how many have run.
 */
const MIGRATIONS = [
  `
  CREATE TABLE book (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    file            TEXT NOT NULL,
    page_count      INTEGER NOT NULL,
    has_page_labels INTEGER NOT NULL,
    outline_nodes   INTEGER NOT NULL,
    target_minutes  INTEGER NOT NULL,
    named           INTEGER NOT NULL,
    added_at        TEXT NOT NULL,
    opened_at       TEXT NOT NULL,
    last_unit       TEXT
  );

  CREATE TABLE unit (
    book_id   TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
    id        TEXT NOT NULL,
    ord       INTEGER NOT NULL,
    title     TEXT NOT NULL,
    chapter   TEXT NOT NULL,
    page_from INTEGER NOT NULL,
    page_to   INTEGER NOT NULL,
    prose     INTEGER NOT NULL,
    code      INTEGER NOT NULL,
    minutes   INTEGER NOT NULL,
    covers    TEXT NOT NULL,
    done_at   TEXT,
    PRIMARY KEY (book_id, id)
  );

  CREATE INDEX unit_order ON unit (book_id, ord);
  `,
  `
  CREATE TABLE brief (
    book_id    TEXT NOT NULL,
    unit_id    TEXT NOT NULL,
    primer     TEXT NOT NULL,
    objectives TEXT NOT NULL,
    model      TEXT NOT NULL,
    made_at    TEXT NOT NULL,
    PRIMARY KEY (book_id, unit_id),
    FOREIGN KEY (book_id, unit_id) REFERENCES unit(book_id, id) ON DELETE CASCADE
  );
  `,
  `
  CREATE TABLE question (
    book_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    ord     INTEGER NOT NULL,
    stem    TEXT NOT NULL,
    options TEXT NOT NULL,
    correct TEXT NOT NULL,
    PRIMARY KEY (book_id, unit_id, ord),
    FOREIGN KEY (book_id, unit_id) REFERENCES unit(book_id, id) ON DELETE CASCADE
  );

  -- One row per unit, not one per sitting: the latest attempt replaces the
  -- previous one. Keeping every attempt is the first half of a review
  -- scheduler, and spaced repetition is out of scope.
  CREATE TABLE attempt (
    book_id  TEXT NOT NULL,
    unit_id  TEXT NOT NULL,
    picks    TEXT NOT NULL,
    score    REAL NOT NULL,
    out_of   INTEGER NOT NULL,
    taken_at TEXT NOT NULL,
    PRIMARY KEY (book_id, unit_id),
    FOREIGN KEY (book_id, unit_id) REFERENCES unit(book_id, id) ON DELETE CASCADE
  );
  `,
  `
  -- How many questions the briefing call produced, so a briefing written before
  -- questions existed (-1) can be told apart from one whose questions were all
  -- dropped by validation (0). The first is regenerated; the second is not.
  ALTER TABLE brief ADD COLUMN questions INTEGER NOT NULL DEFAULT -1;
  `,
  `
  -- The book cut into passages: what retrieval ranks, and the author's own
  -- words rather than anything written about them.
  --
  -- The id is the text's hash rather than its position, so re-extracting a book
  -- leaves untouched passages with the ids they had. #23's embedding pass takes
  -- ~40 minutes and resumes by looking for passages with no vector; ordinal ids
  -- would survive a restart but not a re-extraction, quietly leaving every
  -- vector attached to text it was not made from.
  CREATE TABLE passage (
    book_id      TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
    id           TEXT NOT NULL,
    ord          INTEGER NOT NULL,
    text         TEXT NOT NULL,
    page_from    INTEGER NOT NULL,
    page_to      INTEGER NOT NULL,
    -- Printed pages are what a citation says out loud. NULL on a book with no
    -- /PageLabels, where only the PDF index exists.
    printed_from TEXT,
    printed_to   TEXT,
    chapter      TEXT NOT NULL,
    section      TEXT NOT NULL,
    PRIMARY KEY (book_id, id)
  );

  CREATE INDEX passage_order ON passage (book_id, ord);
  `,
];

let handle: DatabaseSync | null = null;

export function database(): DatabaseSync {
  if (handle) return handle;

  mkdirSync(SHELF, { recursive: true });
  const db = new DatabaseSync(join(HOME, "throughline.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  const { user_version: applied } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  for (let v = Number(applied); v < MIGRATIONS.length; v++) db.exec(MIGRATIONS[v]);
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);

  handle = db;
  return db;
}

/** Run `body` as one transaction, so a half-written book never lands on the shelf. */
export function transaction<T>(body: () => T): T {
  const db = database();
  db.exec("BEGIN");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
