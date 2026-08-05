"use client";

import { useEffect, useRef, useState } from "react";
import type { Course } from "../lib/library";
import type { Unit } from "../src/ingest/units";

interface Book {
  path: string;
  name: string;
  mb: number;
}

export default function Home() {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [course, setCourse] = useState<Course | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    fetch("/api/books")
      .then((r) => r.json())
      .then((d) => setBooks(d.books));
  }, []);

  useEffect(() => {
    if (!path) return;
    setCourse(null);
    setError(null);
    setCurrent(0);
    fetch(`/api/course?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setCourse(d)));
  }, [path]);

  if (!path) {
    return <Picker books={books} onPick={setPath} />;
  }

  if (error) {
    return (
      <div className="center">
        <div className="picker">
          <h1>couldn&apos;t ingest</h1>
          <p>{error}</p>
          <button onClick={() => setPath(null)}>← pick another book</button>
        </div>
      </div>
    );
  }

  if (!course) {
    return (
      <div className="center">
        <p className="muted">Reading the outline…</p>
      </div>
    );
  }

  // The picker lists every PDF in the folder, so a paper with no bookmark
  // outline is a normal thing to land on — not a crash.
  if (course.units.length === 0) {
    return (
      <div className="center">
        <div className="picker">
          <h1>nothing to slice</h1>
          <p>
            <strong>{course.name}</strong> has {course.pageCount} pages but{" "}
            {course.outlineNodes === 0
              ? "no bookmark outline, so there is no structure to cut into units."
              : `only ${course.outlineNodes} outline nodes, none of which carry enough text to be a unit.`}{" "}
            throughline needs a book with chapters — a paper or a scan won&apos;t ingest.
          </p>
          <button onClick={() => setPath(null)}>← pick another book</button>
        </div>
      </div>
    );
  }

  const unit = course.units[current];

  return (
    <div className="app">
      <Sidebar course={course} current={current} onSelect={setCurrent} onBack={() => setPath(null)} />
      <Reader path={course.path} unit={unit} />
    </div>
  );
}

function Picker({
  books,
  onPick,
}: {
  books: Book[] | null;
  onPick: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = books?.filter((b) => b.name.toLowerCase().includes(needle)) ?? [];

  return (
    <div className="center">
      <div className="picker">
        <h1>throughline</h1>
        <p>
          {books === null
            ? "Looking for books…"
            : books.length === 0
              ? "No PDFs found. Set THROUGHLINE_BOOKS to a colon-separated list of paths."
              : "Pick a book — biggest first, since that's usually the books. Ingest takes a couple of seconds."}
        </p>

        {books !== null && books.length > 0 && (
          <input
            className="filter"
            placeholder="Filter by name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        )}

        <div className="pickerlist">
          {matches.map((b) => (
            <button key={b.path} onClick={() => onPick(b.path)}>
              <span>{b.name}</span>
              <span className="size">{b.mb} MB</span>
            </button>
          ))}
          {books !== null && books.length > 0 && matches.length === 0 && (
            <p className="muted">Nothing matches “{query}”.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Sidebar({
  course,
  current,
  onSelect,
  onBack,
}: {
  course: Course;
  current: number;
  onSelect: (i: number) => void;
  onBack: () => void;
}) {
  const hours = Math.round(course.units.reduce((n, u) => n + u.minutes, 0) / 60);
  let chapter = "";

  return (
    <nav className="sidebar">
      <div className="masthead">
        <button className="wordmark" onClick={onBack}>
          throughline
        </button>
        <div className="booktitle">{course.name}</div>
        <div className="stats">
          {course.units.length} units · {hours}h · {course.pageCount} pages
        </div>
      </div>

      {course.units.map((unit, i) => {
        const heading = unit.chapter !== chapter ? ((chapter = unit.chapter), unit.chapter) : null;
        return (
          <div key={unit.id}>
            {heading && <div className="chapter">{heading}</div>}
            <button
              className="unit"
              aria-current={i === current}
              onClick={() => onSelect(i)}
            >
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
        );
      })}
    </nav>
  );
}

function Reader({ path, unit }: { path: string; unit: Unit }) {
  const scroller = useRef<HTMLDivElement>(null);

  // A new unit means a new stretch of the book — start at its first page.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [unit.id]);

  const pages = Array.from({ length: unit.to - unit.from + 1 }, (_, i) => unit.from + i);

  return (
    <main className="reader" ref={scroller}>
      <div className="readerbar">
        <h1>{unit.title}</h1>
        <span className="range">
          pp. {unit.from}–{unit.to} · {unit.minutes} min
        </span>
      </div>

      {unit.covers.length > 1 && <div className="covers">{unit.covers.join(" · ")}</div>}

      <div className="pages">
        {pages.map((page) => (
          <figure key={page}>
            {/* Server-rendered PNG — see Book.renderPage for why not client-side pdf.js. */}
            <img
              src={`/api/page?path=${encodeURIComponent(path)}&page=${page}`}
              alt={`page ${page}`}
              loading="lazy"
            />
            <figcaption className="pagenum">{page}</figcaption>
          </figure>
        ))}
      </div>
    </main>
  );
}
