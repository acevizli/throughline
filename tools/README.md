# tools

## `probe.mjs` — ingest-viability probe

Reports what throughline's ingest can get out of a candidate book, before committing to it.

```bash
npm i pdfjs-dist          # ^6.2.108, Node >= 22.13
node tools/probe.mjs "path/to/book.pdf"
```

Measures the four things ingest depends on:

| | why it matters |
|---|---|
| `/PageLabels` | resolves `see "X" on page 79` → a PDF page. Only needed for prose citations — outline destinations carry indices directly. |
| bookmark outline | the unit hierarchy, page-resolved for free. Falls back to parsing the printed ToC when absent. |
| text layer | chars/page and empty pages. Near-zero means a scan with no OCR — not ingestible. |
| citation density | how many prerequisite edges the book actually contains. Low means a linear syllabus, not a DAG (#11). |

Plus the font-family split, which separates prose from code listings — Clean Code is 35% monospace, so page extent badly misestimates reading time (#4).

Measured so far:

| | DDIA | Clean Code |
|---|---|---|
| pages | 613 | 462 |
| page labels | ✅ | ❌ |
| outline | 210 nodes / 4 levels | 384 nodes / 3 levels |
| `see "X" on page N` | 320 | 12 |
| `Chapter N` | 431 | 3 |
| monospace share | 1% | 35% |

## `rag-probe.ts` — retrieval probe

Does semantic search over this book return the right passages? Embeds a page range with
Voyage and ranks queries against it.

```bash
npm run rag-probe -- "path/to/book.pdf" --from 69 --to 110 \
  --query "writes are appended to a log, and the log is compacted in the background"
```

`--from`/`--to` are **printed** page numbers, resolved through `/PageLabels`; omit them for
the book's body. `--size` (default 900) and `--overlap` (default 0.25) tune the window.
Needs `VOYAGE_API_KEY` in `.env`. With no `--query` it stops before the API call, which is
the quick way to check the extraction alone — though `npm run passages` reports that
better.

**The chunking is not in here.** It is `src/ingest/passages.ts`, the same extractor that
fills the shelf, so what is measured is what ships. It was a standalone `.mjs` script until
the extractor landed, and the two had already drifted apart by the end of that afternoon.

This is the gate on [#23](https://github.com/acevizli/throughline/issues/23). Numbers to
beat, DDIA Chapter 3 (printed 69–110), `voyage-4`, re-measured 2026-08-11 through the real
extractor — the first column is what the standalone script got before it was retired:

| query | script | extractor |
|---|---|---|
| answer is in the slice | 0.616 – 0.661 | **0.661** |
| answer is *not* in the slice | 0.236 ceiling | **0.269 ceiling** |
| `"the branching factor is typically several hundred"` | 0.434, ranked 2nd | **0.402**, answer ranked 3rd at 0.367 |

The separation is what matters and it is wide — a hit at 0.661 against a miss ceiling of
0.269. The third row moved because the window boundaries did; it is one query, and whether
it means anything belongs to the miss log ([#25](https://github.com/acevizli/throughline/issues/25))
rather than to another round of tuning.

One caveat on slices: page furniture is found by repetition, and over 42 pages a
chapter-specific running head may not repeat the 5 times it takes to be recognised. The
whole-book run finds 38 shapes in DDIA where this slice finds 2, so a probe over a few
pages carries slightly more junk than the shelf does.

Pacing note: the free tier's binding limit is **10K tokens/min**, not the 3 requests/min and
not the 1,000-texts-per-request cap. One batch of 135 passages returns 429, so the probe
splits into requests a minute apart — 40 pages takes ~5 minutes.

## `npm run passages` — extraction report

Not in this directory (`src/passages-cli.ts`), but the thing to reach for first: what the
passage extractor gets out of a book, ending with passages printed in full so a human can
read them.

```bash
npm run passages -- "path/to/book.pdf" --sample 4
npm run passages -- "path/to/book.pdf" --shelve   # …and store them, for a book already added
```

DDIA: 552 body pages, 1.25M characters, **1,912 passages**, median 975 characters, none of
the stream lost. Chunking is deliberately naive — overlapping sentence-snapped windows over
a repaired text stream, no paragraph detection and no layout analysis. That was
[measured](https://github.com/acevizli/throughline/issues/26) against per-paragraph chunking
and won. The repairs are the part that matters, and all four are visible in the report:

| repair | what it fixes |
|---|---|
| space at a font change | `as *fractal*` arriving as `asfractal` |
| break hyphens, measured per book | `imple‐ mentation` → `implementation`, without turning `safety-critical` into `safetycritical` |
| running heads and feet | the chapter title landing mid-sentence |
| code listings dropped by line, not by item | keeps inline `null` inside the sentence it belongs to |

## `npm run site` — a tutorial website printed as a book

Some courses are websites, not PDFs: chapters of lessons, one page each. Everything in
throughline counts in PDF pages, so instead of teaching the engine a second coordinate
system, this prints the site into a PDF the ingest already reads
([#30](https://github.com/acevizli/throughline/issues/30)). Then add it to the shelf with
"Open a book".

```bash
npm run site -- <index-url>                      # the page that lists every lesson
npm run site -- <index-url> --chapters 1,2       # a quick look at the first two chapters
npm run site -- <index-url> --skip deprecated    # drop chapters whose heading matches
npm run site -- <index-url> --out ~/Desktop/x.pdf
```

**Nothing in it knows about any one site.** It reads a site the way ingest reads a book:

| | how it's found |
|---|---|
| lessons | the largest family of same-site links sharing a URL directory |
| table of contents | the smallest element holding all of them |
| chapter headings | text in that table that sits in no lesson's row |
| a lesson's text | Mozilla Readability's article, after showing content hidden behind a toggle (quiz solutions) and removing script-only links and buttons (the toggles themselves) |
| how it looks | the site's own classes and stylesheets, inside the same chain of elements the article sat in, so scoped rules (`#main pre…`) still match. Ours go last and take over page size, type size, wrapping and page breaks |
| listings | coloured at print time with Prism, in the language the page declares (`language-*` / `lang-*`), because sites colour code with a script that never runs here. The site's own Prism theme applies when it has one. Line numbers only where the page asks with `line-numbers`, and carried by each line rather than drawn as a separate gutter column, so they can't drift from their lines across a page break and a wrapped line keeps one number. The text inside a `<pre>` is never changed |
| lesson number | the `1.4` a title starts with, if it has one; otherwise its position |

Nothing is written by the tool, so the no-drift rule holds: the page images *are* the
site's text. What it adds is structure the site already states: a divider page per chapter
(short enough to fall under the 200-character floor, so it opens a chapter without becoming
a segment), a two-level bookmark outline, and `/PageLabels` like `1.4·2`. The same string is
printed in each page's footer, so a quiz citation always matches the number on the page.

Fetching is temporary scaffolding, not part of the project. Pages are cached under
`$TMPDIR/throughline-sites/<host>/`, one request at a time with 1.5 s between them, and the
PDF is written there too unless `--out` says otherwise. Nothing lands in the repo. The
creation date is pinned to when the index was fetched, because books are identified by the
sha256 of their bytes. Needs Google Chrome (or `CHROME=/path/to/chrome`).
