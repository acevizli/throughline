"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Course, CourseUnit, ShelfBook } from "../lib/library";

/** Zoom is a multiplier over fit-width, so 1 is "the page fills its column". */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.15;

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

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
    },
    [],
  );

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
  }, [course, current, setDone]);

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
        zoom={zoom}
        onZoom={setZoom}
        focus={focus}
        onFocus={setFocus}
        position={{ index: current, total: course.units.length }}
        onStep={(delta) =>
          setCurrent((i) => Math.min(course.units.length - 1, Math.max(0, i + delta)))
        }
        onDone={(done) => setDone(current, done)}
      />
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
                </span>
              </button>
            </div>
            {i === current && <Briefing key={unit.id} book={course.id} unit={unit} />}
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
function Briefing({ book, unit }: { book: string; unit: CourseUnit }) {
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
        Reading pp. {unit.from}–{unit.to} and writing the briefing. Twenty seconds or so —
        paid once, then it's on disk.
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

/* ── the book ──────────────────────────────────────────────────── */

function Reader({
  book,
  unit,
  zoom,
  onZoom,
  focus,
  onFocus,
  position,
  onStep,
  onDone,
}: {
  book: string;
  unit: CourseUnit;
  zoom: number;
  onZoom: (update: (z: number) => number) => void;
  focus: boolean;
  onFocus: (focus: boolean) => void;
  position: { index: number; total: number };
  onStep: (delta: number) => void;
  onDone: (done: boolean) => void;
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
            pp. {unit.from}–{unit.to} · {unit.minutes} min
          </span>
          <span className="hud-sep" />
          <button
            className={unit.done ? "ghost done" : "ghost"}
            onClick={() => onDone(!unit.done)}
            title="mark complete  d"
          >
            {unit.done ? "✓ complete" : "mark complete"}
          </button>
          {zoomControls}
          <button className="ghost" onClick={() => onFocus(true)} title="full page  f">
            full page
          </button>
        </div>
      )}

      {!focus && unit.covers.length > 1 && <div className="covers">{unit.covers.join(" · ")}</div>}

      <div className={focus ? "pages bare" : "pages"}>
        {pages.map((page) => (
          <figure key={page}>
            {/* Server-rendered PNG — see Pages.render for why not client-side pdf.js. */}
            <img
              src={`/api/page?book=${book}&page=${page}&scale=${scale}`}
              alt={`page ${page}`}
              style={{ width }}
              loading="lazy"
            />
            <figcaption className="pagenum">{page}</figcaption>
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
          <span className="hud-meta">
            pp. {unit.from}–{unit.to}
          </span>
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
