# throughline

Turns a technical book into a course you can actually start.

Point it at a PDF and it produces a roadmap of concept-sized units — each with learning
objectives, a primer naming what the author assumes you already know, and the exact page
range to read — displayed beside the rendered page. Each unit also tells you which earlier
units it leans on, ranked by how often the book cites them. Finish a unit and it asks you
questions over the closed book, where every option — the right ones and the wrong ones —
carries the page that settles it.

Pilot book: *Designing Data-Intensive Applications* (613 pages, 12 chapters).

## The one rule

**Never drift from the book.** The book is the source of knowledge; this is a guide over
it, not a replacement for it. Nothing the system asserts is allowed to be untraceable to
a page.

That constraint is why "leans on" is built from the book's own cross-references rather
than the model's opinion. Kleppmann cites himself constantly — 320 precise references
like `see "B-Trees" on page 79` and 431 chapter references across DDIA — and every entry
carries the sentence and page that produced it, so you can check it.

```
UNIT 31 — Consensus
Read pp. 364–373

Leans on
  U09 Replication lag     29 refs
  U29 Total order bcast   24 refs
  U18 Linearizability     21 refs
     "…as discussed in 'Linearizability' on p.324"
  [shaky? jump back]
```

An earlier design made that a prerequisite DAG with goal-driven entry. Measurement killed
it: 84% of DDIA's citations point backward and every chapter's prerequisites are earlier
chapters, so "what must I read to reach Consensus" resolved to chapters 1–9 in order —
the table of contents with extra steps. The citation *ranking* carried the signal; the
graph didn't.

## Shape

- **Reading guide, not a substitute.** The AI writes objectives, a primer, and the
  questions that check them. It never rewrites the author. The primer is capped at fifty
  words in code, not merely in the prompt: a field that can't exceed fifty words can't
  quietly become the chapter you were supposed to read.
- **Nothing is AI-graded.** The model writes the questions and marks the correct options
  once, when the unit is first opened. Answering is a set comparison in code — no model
  ever judges what you wrote. Every option cites a page inside the unit's own range, and
  a question citing a page outside it is thrown away rather than shown, which is the one
  fully mechanical no-drift check in the system.
- **Concept-boxed units.** One coherent idea per unit, however long that takes — not
  fixed 45-minute blocks, and not a 1:1 re-index of the book's sections.
- **Two-phase generation.** A cheap structural pass at ingest makes the whole roadmap
  visible in seconds; unit content is generated on first open and cached.
- **Generic engine.** DDIA is the pilot, not the target.

Stack: Next.js (App Router) · pdf.js for extraction *and* rendering · SQLite · Anthropic
SDK.

## Running it

```bash
npm install
npm run dev            # http://localhost:3000
```

**Open a book** picks a PDF from disk and adds it to the shelf. Ingest takes a couple of
seconds; unit titles need `ANTHROPIC_API_KEY` in `.env` and add about ten seconds — **paid
once per book, ever**. Without a key you still get units, just structural titles.

After that the book lives on the shelf with its progress, and opens instantly. Tick a unit
off as you finish it; the card shows how far in you are and where to resume.

Opening a unit for the first time writes its **briefing** — a primer, two to five
objectives sized from how much prose the unit holds, and one question per objective — from
the author's text for exactly those pages. One call writes all three, so the pages are read
once. It takes about a minute and is then on disk: every open after that is a database
read, and re-reading the book costs nothing. All of DDIA is 39 such calls. Without a key
the unit still opens; it just says the briefing is unavailable.

Ticking a unit off opens its **questions** over the pages. Four options, one or two of them
correct, and you're not told which — so a blind guess is 10%, not 25%. Answer all of them
and the results panel shows what you picked, what was right, and the page behind every
line, as a link that scrolls the book there. An exact set scores 1, a right-but-incomplete
answer scores a half, and one wrong pick scores nothing.

The tick and the score never overrule each other: the tick means *I read it*, the score
means *I could recall it*, and the shelf carries both. Nothing gates, nothing is taken away
for a wrong answer, and a unit you found hard stays visibly shaky instead of collapsing
into done.

The shelf is
a SQLite database plus a copy of each PDF under `~/.throughline` (override with
`THROUGHLINE_HOME`) — books are copied in rather than referenced, so moving the original
out of Downloads doesn't cost you the ingest.

There's also a CLI that prints the unit list and exits:

```bash
npm run ingest -- ~/Downloads/book.pdf 35 --name
```

## Status

Early, but usable. A book you add stays added: shelf, per-unit completion, resume where
you left off, a full-page reading mode that zooms the page instead of the browser tab, a
briefing above each unit written from its own pages, and page-anchored questions when you
finish one. Not built yet — the "leans on" panel, and printed page numbers (the anchors
currently cite PDF page indices, which run ahead of what DDIA prints on the page).

The design is charted as a wayfinder map — **[issue #1](https://github.com/acevizli/throughline/issues/1)**
holds the locked decisions, the fog that isn't sharp enough to ticket yet, and what's
ruled out of scope. Its sub-issues are the open questions, wired with native GitHub
dependencies so the frontier — what's actually takeable right now — renders in the issue UI.
