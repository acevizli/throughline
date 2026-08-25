"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AskedQuestion, Course, CourseUnit, Marked, Quiz, ShelfBook } from "../lib/library";
import type { Key } from "../src/ingest/brief";
import { caption, cite, citeRange, type Labels } from "../lib/printed";
import { TextLayer } from "./text-layer";

/** Zoom is a multiplier over fit-width, so 1 is "the page fills its column". */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.15;

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** Whichever page is at the top of the reading pane right now. */
function topPage(): number | null {
  for (const figure of document.querySelectorAll<HTMLElement>(".pages figure")) {
    if (figure.getBoundingClientRect().bottom > 100) return Number(figure.id.replace("page-", ""));
  }
  return null;
}

export default function Home() {
  const [books, setBooks] = useState<ShelfBook[] | null>(null);
  const [course, setCourse] = useState<Course | null>(null);
  const [current, setCurrent] = useState(0);
  const [focus, setFocus] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadShelf = useCallback(async () => {
    const data = await fetch("/api/books").then((r) => r.json());
    setBooks(data.books);
  }, []);

  useEffect(() => {
    loadShelf();
  }, [loadShelf]);

  const open = useCallback(async (id: string) => {
    const found: Course = await fetch(`/api/book?id=${id}`).then((r) => r.json());
    const at = found.units.findIndex((u) => u.id === found.lastUnit);
    setCourse(found);
    setCurrent(at === -1 ? 0 : at);
    setFocus(false);
  }, []);

  const close = useCallback(() => {
    setCourse(null);
    loadShelf();
  }, [loadShelf]);

  // Keep the place, so the shelf can offer to resume. Fire-and-forget: losing
  // one of these costs a scroll, not a re-ingest.
  useEffect(() => {
    const unit = course?.units[current];
    if (!course || !unit) return;
    fetch("/api/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ book: course.id, unit: unit.id }),
    }).catch(() => {});
  }, [course, current]);

  // Which unit's questions are on screen. Ticking a unit off opens them: the
  // questions are the other half of finishing a unit, and burying them behind a
  // button nobody presses would have made grading decorative.
  const [quizzing, setQuizzing] = useState<string | null>(null);

  const setDone = useCallback(
    (index: number, done: boolean) => {
      setCourse((c) => {
        if (!c) return c;
        const units = c.units.map((u, i) => (i === index ? { ...u, done } : u));
        fetch("/api/progress", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ book: c.id, unit: c.units[index].id, done }),
        }).catch(() => {});
        return { ...c, units };
      });
      if (done) setQuizzing(course?.units[index].id ?? null);
    },
    [course],
  );

  /** A page the reader asked to be taken to, once it's on screen to be taken to. */
  const [pending, setPending] = useState<number | null>(null);

  /**
   * Where a cross-unit jump came from, so it can be undone.
   *
   * Tagged with the unit it landed on rather than cleared on every other kind
   * of navigation: the offer to go back is only meaningful while you are still
   * standing where the link put you.
   */
  const [origin, setOrigin] = useState<{ from: number; page: number | null; to: number } | null>(
    null,
  );

  /**
   * A page anchor was followed — out of the results panel, or off one of the
   * book's own cross-references.
   *
   * Question anchors always land inside the unit that asked them, but the
   * book's links point wherever the author pointed: `see "B-Trees" on page 79`
   * from chapter 7 is four units back. Only the current unit's pages are
   * rendered, so the unit has to move first or the anchor is a dead link.
   */
  const jump = useCallback(
    (page: number) => {
      setQuizzing(null);
      const units = course?.units ?? [];
      const target = units.findIndex((u) => page >= u.from && page <= u.to);
      if (target !== -1 && target !== current) {
        // Following a citation out of the unit you were reading should not cost
        // you your place in it.
        setOrigin({ from: current, page: topPage(), to: target });
        setCurrent(target);
      }
      setPending(page);
    },
    [course, current],
  );

  /**
   * Scroll to a followed page once it exists.
   *
   * Deferred to an effect rather than done in the handler because following a
   * link across units re-renders the whole pane; the element only exists after
   * that render. Child effects run first, so this also beats the reader's own
   * scroll-to-top on a unit change.
   */
  useEffect(() => {
    if (pending === null) return;
    document
      .getElementById(`page-${pending}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    setPending(null);
  }, [pending, current]);

  /** Undo the last jump that left the unit, landing back on the page you left. */
  const unjump = useCallback(() => {
    if (!origin) return;
    setCurrent(origin.from);
    setPending(origin.page);
    setOrigin(null);
  }, [origin]);

  // Zoom and unit keys live on the window, because in focus mode there is no
  // chrome to click. Cmd/Ctrl +/-/0 are swallowed so the *page* zooms instead
  // of the browser tab, which is what made zooming useless before.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

      switch (event.key) {
        case "+":
        case "=":
          event.preventDefault();
          return setZoom((z) => clampZoom(z * ZOOM_STEP));
        case "-":
        case "_":
          event.preventDefault();
          return setZoom((z) => clampZoom(z / ZOOM_STEP));
        case "0":
          event.preventDefault();
          return setZoom(1);
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!course) return;

      // With questions on screen the shortcuts would move the book out from
      // under them; Escape closes, everything else waits.
      if (quizzing) {
        if (event.key === "Escape") setQuizzing(null);
        return;
      }

      switch (event.key) {
        case "f":
          return setFocus((f) => !f);
        case "Escape":
          return setFocus(false);
        case "[":
          return setCurrent((i) => Math.max(0, i - 1));
        case "]":
          return setCurrent((i) => Math.min(course.units.length - 1, i + 1));
        case "d":
          return setDone(current, !course.units[current].done);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [course, current, setDone, quizzing]);

  const addBook = useCallback(
    async (file: File) => {
      setError(null);
      setAdding(file.name);
      try {
        const response = await fetch(`/api/books?name=${encodeURIComponent(file.name)}`, {
          method: "POST",
          body: file,
        });
        const result = await response.json();
        if (result.error) setError(result.error);
        else {
          await loadShelf();
          await open(result.id);
        }
      } catch (cause) {
        setError(`Couldn't add ${file.name}: ${(cause as Error).message}`);
      } finally {
        setAdding(null);
      }
    },
    [loadShelf, open],
  );

  const remove = useCallback(
    async (id: string) => {
      await fetch(`/api/book?id=${id}`, { method: "DELETE" });
      loadShelf();
    },
    [loadShelf],
  );

  if (!course) {
    return (
      <Shelf
        books={books}
        adding={adding}
        error={error}
        onAdd={addBook}
        onOpen={open}
        onRemove={remove}
      />
    );
  }

  return (
    <div className={focus ? "app focus" : "app"}>
      {!focus && (
        <Sidebar
          course={course}
          current={current}
          onSelect={setCurrent}
          onDone={setDone}
          onBack={close}
        />
      )}
      <Reader
        book={course.id}
        unit={course.units[current]}
        printed={course.printed}
        zoom={zoom}
        onZoom={setZoom}
        focus={focus}
        onFocus={setFocus}
        position={{ index: current, total: course.units.length }}
        onStep={(delta) =>
          setCurrent((i) => Math.min(course.units.length - 1, Math.max(0, i + delta)))
        }
        onDone={(done) => setDone(current, done)}
        onQuiz={() => setQuizzing(course.units[current].id)}
        onFollow={jump}
        back={origin?.to === current ? course.units[origin.from].title : null}
        onUnjump={unjump}
      />
      {quizzing && (
        <Questions
          key={quizzing}
          book={course.id}
          unit={course.units.find((u) => u.id === quizzing)!}
          printed={course.printed}
          onClose={() => setQuizzing(null)}
          onJump={jump}
          onMarked={(recall) =>
            setCourse((c) =>
              c
                ? { ...c, units: c.units.map((u) => (u.id === quizzing ? { ...u, recall } : u)) }
                : c,
            )
          }
        />
      )}
    </div>
  );
}

/* ── the shelf ─────────────────────────────────────────────────── */

function Shelf({
  books,
  adding,
  error,
  onAdd,
  onOpen,
  onRemove,
}: {
  books: ShelfBook[] | null;
  adding: string | null;
  error: string | null;
  onAdd: (file: File) => void;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);

  return (
    <div className="shelfpage">
      <header className="shelfhead">
        <div>
          <h1>throughline</h1>
          <p className="muted">
            {books === null
              ? "Opening the shelf…"
              : books.length === 0
                ? "Nothing on the shelf yet. Open a PDF to cut it into units."
                : `${books.length} book${books.length === 1 ? "" : "s"} on the shelf.`}
          </p>
        </div>
        <button className="primary" onClick={() => picker.current?.click()} disabled={!!adding}>
          {adding ? "reading…" : "Open a book"}
        </button>
        <input
          ref={picker}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // so picking the same file twice still fires
            if (file) onAdd(file);
          }}
        />
      </header>

      {error && <p className="failed">{error}</p>}

      <div className="shelf">
        {adding && (
          <article className="card working">
            <h2>{adding.replace(/\.pdf$/i, "")}</h2>
            <p className="muted">
              Reading the outline, then one AI pass to name the units. Paid once — after
              this the book opens instantly.
            </p>
          </article>
        )}

        {books?.map((book) => {
          const percent = book.minutes ? Math.round((book.doneMinutes / book.minutes) * 100) : 0;
          const left = Math.round((book.minutes - book.doneMinutes) / 60);
          return (
            <article key={book.id} className="card">
              <button className="cardopen" onClick={() => onOpen(book.id)}>
                <h2>{book.title}</h2>
                <div className="bar">
                  <span style={{ width: `${percent}%` }} />
                </div>
                <div className="cardstats">
                  <strong>{percent}%</strong> · {book.doneUnits}/{book.units} units ·{" "}
                  {left ? `${left}h left` : "done"}
                </div>
                {/* The second number, deliberately beside the percentage and never
                    folded into it: one says read, the other says retained. */}
                {book.clean + book.shaky > 0 && (
                  <div className="cardstats">
                    <span className="clean">{book.clean} recalled clean</span>
                    {book.shaky > 0 && <span className="shaky"> · {book.shaky} shaky</span>}
                  </div>
                )}
                <div className="cardgo">
                  {book.doneUnits === book.units
                    ? "read again"
                    : book.lastUnit
                      ? `continue at ${book.lastUnit} →`
                      : "start →"}
                </div>
              </button>
              <button
                className="remove"
                title="remove from the shelf"
                onClick={() => {
                  if (confirm(`Remove "${book.title}" and its progress from the shelf?`)) {
                    onRemove(book.id);
                  }
                }}
              >
                ×
              </button>
            </article>
          );
        })}
      </div>
    </div>
  );
}

/* ── the roadmap ───────────────────────────────────────────────── */

function Sidebar({
  course,
  current,
  onSelect,
  onDone,
  onBack,
}: {
  course: Course;
  current: number;
  onSelect: (i: number) => void;
  onDone: (index: number, done: boolean) => void;
  onBack: () => void;
}) {
  const minutes = course.units.reduce((n, u) => n + u.minutes, 0);
  const doneMinutes = course.units.reduce((n, u) => n + (u.done ? u.minutes : 0), 0);
  const doneUnits = course.units.filter((u) => u.done).length;
  const percent = minutes ? Math.round((doneMinutes / minutes) * 100) : 0;
  let chapter = "";

  return (
    <nav className="sidebar">
      <div className="masthead">
        <button className="wordmark" onClick={onBack}>
          ← shelf
        </button>
        <div className="booktitle">{course.title}</div>
        <div className="bar">
          <span style={{ width: `${percent}%` }} />
        </div>
        <div className="stats">
          {percent}% · {doneUnits}/{course.units.length} units · {Math.round(minutes / 60)}h
        </div>
      </div>

      {course.units.map((unit, i) => {
        const heading = unit.chapter !== chapter ? ((chapter = unit.chapter), unit.chapter) : null;
        return (
          <div key={unit.id}>
            {heading && <div className="chapter">{heading}</div>}
            <div className="unitrow" data-done={unit.done}>
              <button
                className="tick"
                role="checkbox"
                aria-checked={unit.done}
                aria-label={`mark ${unit.id} complete`}
                onClick={() => onDone(i, !unit.done)}
              >
                {unit.done ? "✓" : ""}
              </button>
              <button className="unit" aria-current={i === current} onClick={() => onSelect(i)}>
                <span className="unit-head">
                  <span className="unit-id">{unit.id}</span>
                  <span className="unit-title">{unit.title}</span>
                </span>
                <span className="unit-meta">
                  {unit.minutes} min
                  {unit.code > unit.prose * 0.4 && (
                    <span className="codeflag"> · +{Math.round(unit.code / 1000)}k code</span>
                  )}
                  {unit.recall && (
                    <span className={unit.recall.score === unit.recall.outOf ? "clean" : "shaky"}>
                      {" · "}
                      {points(unit.recall.score)}/{unit.recall.outOf} recalled
                    </span>
                  )}
                </span>
              </button>
            </div>
            {i === current && (
              <Briefing key={unit.id} book={course.id} unit={unit} printed={course.printed} />
            )}
          </div>
        );
      })}
    </nav>
  );
}

/**
 * The briefing for the open unit, expanded in place under its row.
 *
 * It lives in the roadmap rather than above the pages because it is read on the
 * way into the unit and not during it: the right-hand pane belongs to the book.
 */
function Briefing({ book, unit, printed }: { book: string; unit: CourseUnit; printed: Labels }) {
  const [brief, setBrief] = useState<
    { primer: string; objectives: string[] } | { error: string } | null
  >(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setBrief(null);
    fetch(`/api/brief?book=${book}&unit=${unit.id}${attempt ? "&fresh=1" : ""}`)
      .then((r) => r.json())
      .then((data) => live && setBrief(data))
      .catch((cause) => live && setBrief({ error: (cause as Error).message }));
    return () => {
      live = false;
    };
  }, [book, unit.id, attempt]);

  if (!brief) {
    return (
      <div className="brief working">
        Reading {citeRange(printed, unit.from, unit.to)}, writing the briefing and setting this
        unit's questions. About a minute — paid once, then it's on disk.
      </div>
    );
  }

  if ("error" in brief) {
    return (
      <div className="brief failed">
        {brief.error}
        <button className="ghost" onClick={() => setAttempt((n) => n + 1)}>
          try again
        </button>
      </div>
    );
  }

  return (
    <div className="brief">
      {brief.primer && <p className="primer">{brief.primer}</p>}
      <ol className="objectives">
        {brief.objectives.map((objective) => (
          <li key={objective}>{objective}</li>
        ))}
      </ol>
      <button className="ghost rewrite" onClick={() => setAttempt((n) => n + 1)}>
        rewrite
      </button>
    </div>
  );
}

/* ── the questions ─────────────────────────────────────────────── */

/** Fisher–Yates. The stems are stored in one order and shown in another. */
function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** How a score reads. Halves exist, so 2.5 has to print as 2.5 and 3 as 3. */
const points = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/**
 * A unit's questions, over the pages.
 *
 * Deliberately covering the book rather than sitting beside it: the whole point
 * is answering with the book closed, and a checkbox list next to the page you
 * were just reading is an open-book test with extra steps.
 */
function Questions({
  book,
  unit,
  printed,
  onClose,
  onJump,
  onMarked,
}: {
  book: string;
  unit: CourseUnit;
  printed: Labels;
  onClose: () => void;
  onJump: (page: number) => void;
  onMarked: (recall: { score: number; outOf: number }) => void;
}) {
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [picks, setPicks] = useState<Key[][]>([]);
  /** Display order per question — kept so the results don't reshuffle underneath. */
  const [order, setOrder] = useState<Key[][]>([]);
  const [sending, setSending] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    setQuiz(null);
    fetch(`/api/quiz?book=${book}&unit=${unit.id}`)
      .then((r) => r.json())
      .then((data: Quiz) => {
        if (!live) return;
        setQuiz(data);
        if (data.state === "asking") {
          setPicks(data.questions.map(() => []));
          setOrder(data.questions.map((q) => shuffle(q.options.map((o) => o.key))));
        } else if (data.state === "marked") {
          setOrder(data.result.questions.map((q) => q.options.map((o) => o.key)));
        }
      })
      .catch((cause) => live && setQuiz({ state: "none", reason: (cause as Error).message }));
    return () => {
      live = false;
    };
  }, [book, unit.id, round]);

  const toggle = (index: number, key: Key) =>
    setPicks((all) =>
      all.map((chosen, i) =>
        i !== index ? chosen : chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key],
      ),
    );

  const submit = async () => {
    setSending(true);
    try {
      const result: Marked = await fetch("/api/quiz", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ book, unit: unit.id, picks }),
      }).then((r) => r.json());
      setQuiz({ state: "marked", result });
      onMarked({ score: result.score, outOf: result.outOf });
    } finally {
      setSending(false);
    }
  };

  const again = async () => {
    await fetch(`/api/quiz?book=${book}&unit=${unit.id}`, { method: "DELETE" });
    setRound((n) => n + 1);
  };

  return (
    <div className="quizveil" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="quizcard">
        <header className="quizhead">
          <div>
            <div className="quizunit">
              {unit.id} — {unit.title}
            </div>
            <div className="quizsub">
              {quiz?.state === "marked"
                ? `${points(quiz.result.score)} of ${quiz.result.outOf}`
                : `${citeRange(printed, unit.from, unit.to)} · book closed`}
            </div>
          </div>
          <button className="ghost" onClick={onClose}>
            close
          </button>
        </header>

        {!quiz && <p className="quiznote">Fetching this unit's questions…</p>}

        {quiz?.state === "none" && <p className="quiznote">{quiz.reason}</p>}

        {quiz?.state === "asking" && (
          <>
            {quiz.questions.map((question, i) => (
              <Asked
                key={question.ord}
                question={question}
                index={i}
                order={order[i] ?? []}
                picked={picks[i] ?? []}
                onToggle={(key) => toggle(i, key)}
              />
            ))}
            <footer className="quizfoot">
              <span className="quiznote">
                {picks.filter((p) => p.length).length} of {quiz.questions.length} answered · one or
                two options each
              </span>
              <button className="primary" onClick={submit} disabled={sending}>
                {sending ? "marking…" : "check"}
              </button>
            </footer>
          </>
        )}

        {quiz?.state === "marked" && (
          <>
            {quiz.result.questions.map((question, i) => (
              <div key={question.ord} className="qblock" data-got={question.got}>
                <div className="qstem">
                  <span className="qmark">
                    {question.got === 1 ? "✓" : question.got === 0 ? "✗" : "◑"}
                  </span>
                  {question.stem}
                </div>
                {(order[i] ?? question.options.map((o) => o.key)).map((key) => {
                  const option = question.options.find((o) => o.key === key)!;
                  return (
                    <div
                      key={key}
                      className="qopt result"
                      data-correct={option.correct}
                      data-picked={option.picked}
                    >
                      <span className="qbox">{option.picked ? "■" : "□"}</span>
                      <span className="qtext">{option.text}</span>
                      {/* The page is stored as a PDF index, because that is what
                          the jump needs; what it is *called* is the book's own. */}
                      <button className="anchor" onClick={() => onJump(option.page)}>
                        {cite(printed, option.page)}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
            <footer className="quizfoot">
              <span className="quiznote">
                Every line above is auditable — follow a page to see what settles it.
              </span>
              <button className="ghost" onClick={again}>
                take again
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

function Asked({
  question,
  index,
  order,
  picked,
  onToggle,
}: {
  question: AskedQuestion;
  index: number;
  order: Key[];
  picked: Key[];
  onToggle: (key: Key) => void;
}) {
  return (
    <div className="qblock">
      <div className="qstem">
        <span className="qnum">{index + 1}</span>
        {question.stem}
      </div>
      {order.map((key) => {
        const option = question.options.find((o) => o.key === key)!;
        return (
          <button
            key={key}
            className="qopt"
            role="checkbox"
            aria-checked={picked.includes(key)}
            data-picked={picked.includes(key)}
            onClick={() => onToggle(key)}
          >
            <span className="qbox">{picked.includes(key) ? "■" : "□"}</span>
            <span className="qtext">{option.text}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ── the book ──────────────────────────────────────────────────── */

function Reader({
  book,
  unit,
  printed,
  zoom,
  onZoom,
  focus,
  onFocus,
  position,
  onStep,
  onDone,
  onQuiz,
  onFollow,
  back,
  onUnjump,
}: {
  book: string;
  unit: CourseUnit;
  printed: Labels;
  zoom: number;
  onZoom: (update: (z: number) => number) => void;
  focus: boolean;
  onFocus: (focus: boolean) => void;
  position: { index: number; total: number };
  onStep: (delta: number) => void;
  onDone: (done: boolean) => void;
  onQuiz: () => void;
  onFollow: (page: number) => void;
  /** The unit a followed link took you out of, while you're still away from it. */
  back: string | null;
  onUnjump: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [column, setColumn] = useState(760);

  // A new unit means a new stretch of the book — start at its first page.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [unit.id]);

  // Zoom 1 means "as wide as the pane allows, up to a comfortable measure", so
  // the multiplier has to be applied to a measured width rather than a constant.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setColumn(Math.max(280, Math.min(860, element.clientWidth - 48)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [focus]);

  // Ctrl/Cmd-wheel and trackpad pinch (which arrives as a ctrlKey wheel) zoom
  // the pages. Registered natively because React's pooled wheel handler is
  // passive, and a passive listener cannot preventDefault the browser's zoom.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      onZoom((z) => clampZoom(z * Math.exp(-event.deltaY / 300)));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [onZoom]);

  const width = Math.round(column * zoom);

  // Ask the server for a render that still has pixels to spare at this width,
  // in whole steps: a continuous scale would miss the cache on every nudge.
  const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
  const scale = Math.min(4, Math.max(2, Math.ceil((width * dpr) / 700)));

  const pages = Array.from({ length: unit.to - unit.from + 1 }, (_, i) => unit.from + i);
  const zoomControls = (
    <>
      <button className="ghost" onClick={() => onZoom((z) => clampZoom(z / ZOOM_STEP))}>
        −
      </button>
      <button className="ghost zoomlevel" onClick={() => onZoom(() => 1)} title="reset zoom  0">
        {Math.round(zoom * 100)}%
      </button>
      <button className="ghost" onClick={() => onZoom((z) => clampZoom(z * ZOOM_STEP))}>
        +
      </button>
    </>
  );

  return (
    <main className="reader" ref={scroller}>
      {!focus && (
        <div className="readerbar">
          <h1>{unit.title}</h1>
          <span className="range">
            {citeRange(printed, unit.from, unit.to)} · {unit.minutes} min
          </span>
          <span className="hud-sep" />
          <button
            className={unit.done ? "ghost done" : "ghost"}
            onClick={() => onDone(!unit.done)}
            title="mark complete  d"
          >
            {unit.done ? "✓ complete" : "mark complete"}
          </button>
          {unit.done && (
            <button className="ghost" onClick={onQuiz} title="answer this unit's questions">
              {unit.recall
                ? `${points(unit.recall.score)}/${unit.recall.outOf} recalled`
                : "questions"}
            </button>
          )}
          {back && (
            <button className="ghost" onClick={onUnjump} title="back to where you were reading">
              ← {back}
            </button>
          )}
          {zoomControls}
          <button className="ghost" onClick={() => onFocus(true)} title="full page  f">
            full page
          </button>
        </div>
      )}

      {!focus && unit.covers.length > 1 && <div className="covers">{unit.covers.join(" · ")}</div>}

      <div className={focus ? "pages bare" : "pages"}>
        {pages.map((page) => (
          // The id is what a page anchor scrolls to — from the results panel,
          // and from the book's own cross-references.
          <figure key={page} id={`page-${page}`}>
            <div className="pageframe" style={{ width }}>
              {/* Server-rendered PNG — see Pages.render for why not client-side pdf.js. */}
              <img
                src={`/api/page?book=${book}&page=${page}&scale=${scale}`}
                alt={`page ${caption(printed, page)}`}
                loading="lazy"
              />
              {/* …and the words themselves on top of it, so the picture of a
                  page is a page again. See Pages.geometry. */}
              <TextLayer
                book={book}
                page={page}
                printed={printed}
                width={width}
                onFollow={onFollow}
              />
            </div>
            {/* The folio the book prints, so it agrees with the page above it.
                Bare on a book with none: this counts sheets, it doesn't cite. */}
            <figcaption className="pagenum">{caption(printed, page)}</figcaption>
          </figure>
        ))}
      </div>

      {focus && (
        <div className="hud">
          <button
            className="ghost"
            onClick={() => onStep(-1)}
            disabled={position.index === 0}
            title="previous unit  ["
          >
            ‹
          </button>
          <span className="hud-title">{unit.title}</span>
          <span className="hud-meta">{citeRange(printed, unit.from, unit.to)}</span>
          <button
            className="ghost"
            onClick={() => onStep(1)}
            disabled={position.index === position.total - 1}
            title="next unit  ]"
          >
            ›
          </button>
          <span className="hud-sep" />
          <button
            className={unit.done ? "ghost done" : "ghost"}
            onClick={() => onDone(!unit.done)}
            title="mark complete  d"
          >
            {unit.done ? "✓" : "mark done"}
          </button>
          <span className="hud-sep" />
          {back && (
            <>
              <button className="ghost" onClick={onUnjump} title="back to where you were reading">
                ← {back}
              </button>
              <span className="hud-sep" />
            </>
          )}
          {zoomControls}
          <span className="hud-sep" />
          <button className="ghost" onClick={() => onFocus(false)} title="exit  esc">
            exit
          </button>
        </div>
      )}
    </main>
  );
}
