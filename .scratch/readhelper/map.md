# ReadHelper — book-to-course engine

## Destination

A local Next.js app where pointing it at a technical PDF yields a citation-grounded
prerequisite graph of concept-sized units; each unit shows its objectives, a primer and
the exact page range beside the rendered PDF page; recall answers are AI-graded against
the source pages. Done when DDIA has run through it end to end and is actually being
read from it.

## Notes

**Domain:** PDF structure extraction, curriculum design, LLM generation + grading.

**Skills every session should consult:** `/grilling`, `/domain-modeling`, `/prototype`,
`/research`.

**Execution override:** this map carries execution, not just decisions. Prototype
tickets leave working code behind, not just a verdict.

**Standing constraint — never drift from the book.** The book is the source of
knowledge. Anything the system asserts must be traceable to a page. This outranks
convenience everywhere: DAG edges come from the book's own citations, grading is against
the source pages, and AI never rewrites the author's explanation.

### Decisions taken before charting (the grilling that produced this map)

| Question | Answer |
|---|---|
| Guide or substitute? | **Reading guide over the book.** AI produces objectives, primer, page range, recall questions. It never replaces the prose. |
| This book or any book? | **Generic engine, DDIA as the pilot.** |
| Surface | **Local web app** — unit pane beside a rendered PDF pane. |
| What is a unit? | **Concept-boxed** — one coherent idea, variable length (15–90 min). Not time-boxed, not a 1:1 mirror of the book's sections. |
| Roadmap shape | **Prerequisite DAG** — not every book has a clean linear order. |
| Where do edges come from? | **The book's own citations only** — `see "B-Trees" on page 79`, `Chapter 9` — plus the implicit previous-unit-in-chapter edge. Every edge auditable to a sentence and a page. |
| Assessment | **AI-graded free recall** against each objective *and* the source pages. |
| Generation timing | **Two-phase** — cheap structural pass at ingest makes the whole roadmap visible in seconds; rich unit content generated lazily on first open, then cached. |
| Stack | **All TypeScript** — Next.js (App Router) + pdf.js for extraction *and* rendering + SQLite + Anthropic SDK. |

### Facts established against the pilot PDF

`/Users/kobil/Downloads/Designing Data Intensive Applications by Martin Kleppmann.pdf`

- 613 pages, 12 chapters, 3 parts. Clean text layer — `pdftotext` works, no OCR needed.
- The printed ToC gives a full Part → Chapter → H2 → H3 hierarchy **with printed page
  numbers**, so unit boundaries and page ranges are derivable without pushing 613 pages
  through a model.
- No PDF bookmark outline (`Tagged: no`) — the printed ToC is the structure source.
- **The citation graph is real and dense.** Pages 30–260 alone contain 171 `Chapter N`
  references and 80 precise `see "<Section Title>" on page N` references. Extrapolated:
  roughly 500 chapter-level and 250 section-level citations across the book. The DAG can
  be extracted, not invented.
- **Printed page numbers ≠ PDF page indices.** The ToC says Chapter 1 starts at page 3;
  that content sits around PDF page 25, and front matter is roman-numbered. Everything
  downstream depends on this offset.

## Decisions so far

<!-- one line per resolved ticket: gist + link -->

_(none yet — this map was charted in one session and hand-resolved nothing)_

## Not yet specified

- **Reading ergonomics** — highlighting, margin notes; what a note attaches to (a unit?
  a page? an objective?).
- **Cross-book graph** — once a second book is ingested, do units from different books
  ever link to each other, or is each book an island?
- **Re-ingest invalidation** — what happens to a completed unit when the citation graph
  or unit boundaries change on re-ingest of an updated PDF.
- **API key handling and per-book cost ceiling** — where the key lives, whether ingest
  is allowed to blow past a budget.
- **Export** — does a finished course leave the app as markdown?

## Out of scope

- **AI-written lecture content that replaces reading the book** — explicitly rejected
  during charting. The compression is where the value was; the book stays the text.
- **Spaced repetition / SRS scheduling** — a second system (scheduler, review queue,
  card state) bolted onto the first. Rejected for v1.
- **Auth, multi-user, hosting** — single local user only.
- **Non-PDF sources** (EPUB, video, papers).
