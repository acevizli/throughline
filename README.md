# throughline

Turns a technical book into a course you can actually start.

Point it at a PDF and it produces a roadmap of concept-sized units — each with learning
objectives, a primer on what to watch for, and the exact page range to read — displayed
beside the rendered page. Each unit also tells you which earlier units it leans on, ranked
by how often the book cites them. Answer the recall questions afterwards and they're
graded against the book's own pages.

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

- **Reading guide, not a substitute.** The AI writes objectives, primers and questions.
  It never rewrites the author.
- **Concept-boxed units.** One coherent idea per unit, however long that takes — not
  fixed 45-minute blocks, and not a 1:1 re-index of the book's sections.
- **Two-phase generation.** A cheap structural pass at ingest makes the whole roadmap
  visible in seconds; unit content is generated on first open and cached.
- **Generic engine.** DDIA is the pilot, not the target.

Stack: Next.js (App Router) · pdf.js for extraction *and* rendering · SQLite · Anthropic
SDK.

## Status

Early. The design is charted as a wayfinder map — **[issue #1](https://github.com/acevizli/throughline/issues/1)**
holds the locked decisions, the fog that isn't sharp enough to ticket yet, and what's
ruled out of scope. Its sub-issues are the open questions, wired with native GitHub
dependencies so the frontier — what's actually takeable right now — renders in the issue
UI. No application code exists.
